import fs from "fs"; 
import dotenv from "dotenv";
import express from "express";
import axios from "axios";
import qrcode from "qrcode";
import humps from "humps";
import { Client, Contact, GroupChat, GroupNotification, GroupParticipant, LocalAuth, MessageContent, MessageMedia } from "whatsapp-web.js";
import { ChatwootAPI } from "./ChatwootAPI";
import { ChatwootMessage } from "./types";
import { Readable } from "stream";
import FormData from "form-data";
import { group, info } from "console";

if (
    !process.env.CHATWOOT_API_URL ||
    !process.env.CHATWOOT_API_KEY ||
    !process.env.CHATWOOT_ACCOUNT_ID ||
    !process.env.WHATSAPP_WEB_CHATWOOT_INBOX_ID
) {
    // assert that required envs are set or try to fallback to file
    try {
        fs.accessSync(".env", fs.constants.F_OK);
        dotenv.config();
    } catch {
        console.error("ENV vars aren't set.");
        process.exit(1);
    }
}

const expressApp = express();
const puppeteer = process.env.DOCKERIZED ? {
    headless: true,
    args: ["--no-sandbox"],
    executablePath: "google-chrome-stable"
} : {};

const whatsappWebClient = new Client({
    authStrategy: new LocalAuth(),
    puppeteer: puppeteer
});

const chatwootAPI: ChatwootAPI = new ChatwootAPI(
    process.env.CHATWOOT_API_URL ?? "",
    process.env.CHATWOOT_API_KEY ?? "",
    process.env.CHATWOOT_ACCOUNT_ID ?? "",
    process.env.WHATSAPP_WEB_CHATWOOT_INBOX_ID ?? "",
    whatsappWebClient
);

expressApp.use(
    express.urlencoded({
        extended: true,
    }),
    express.json()
);

whatsappWebClient.on("qr", (qr) => {
    qrcode.toString(qr, { type: "terminal", small: true }, (err, buffer) => {
        if (!err) {
            console.log(buffer);
        } else {
            console.error(err);
        }
    });

    if (process.env.SLACK_TOKEN) {
        qrcode.toBuffer(qr, { scale: 6 }, (err, buffer) => {
            console.log(buffer);

            const form = new FormData();

            form.append("token", process.env.SLACK_TOKEN ?? "");
            form.append("channels", process.env.SLACK_CHANNEL_ID ?? "");
            form.append("title", "QR Code");
            form.append("initial_comment", "WahtsApp needs to connect, use this code to authorize your number:");
            form.append("file", new Readable({
                read() {
                    this.push(buffer);
                    this.push(null);
                }
            }), "qr.png");

            if (!err) {
                axios.postForm("https://slack.com/api/files.upload", form, {
                    headers: form.getHeaders(),
                })
                    .then(response => {
                        console.log(response.data);
                    })
                    .catch(err => {
                        console.error(err);
                    });
            } else {
                console.error(err);
            }
        });
    }
});

whatsappWebClient.on("ready", () => {
    console.log("Client is ready!");
});

whatsappWebClient.on("message", async (message) => {
    let attachment = null;
    if(message.hasMedia) {
        attachment = await message.downloadMedia();
    }

    chatwootAPI.broadcastMessageToChatwoot(message, "incoming", attachment, process.env.REMOTE_PRIVATE_MESSAGE_PREFIX);
});

whatsappWebClient.on("message_create", async (message) => {
    if(message.fromMe)
    {
        
        let attachment:MessageMedia | undefined;
        const rawData:any = message.rawData;
        //broadcast WA message to chatwoot only if it was created
        //from a real device/wa web and not from chatwoot app
        //to avoid endless loop
        if(rawData.self == "in")
        {
            if(message.hasMedia) {
                attachment = await message.downloadMedia();
            }
        
            chatwootAPI.broadcastMessageToChatwoot(message, "outgoing", attachment, process.env.REMOTE_PRIVATE_MESSAGE_PREFIX);
        }
    }
});

whatsappWebClient.on("group_join", async (groupNotification:GroupNotification) => {
    const groupChat:GroupChat = (await groupNotification.getChat()) as GroupChat;
    chatwootAPI.updateChatwootConversationGroupParticipants(groupChat);
});

whatsappWebClient.on("group_leave", async (groupNotification:GroupNotification) => {
    const groupChat:GroupChat = (await groupNotification.getChat()) as GroupChat;
    chatwootAPI.updateChatwootConversationGroupParticipants(groupChat);
});


whatsappWebClient.initialize().catch(console.error);

expressApp.get("/", async (req, res) => {
    res.status(200).json({
        status: "OK",
        req: req.ip,
    });
});

expressApp.post("/chatwootMessage", async (req, res) => {
    try {
        
        //const chatwootMessage: ChatwootMessage = humps.camelizeKeys(req.body);
        const chatwootMessage = req.body;

        const whatsappWebClientState = await whatsappWebClient.getState();
        //post to whatsapp only if we are connected to the client and message is not private
        if (whatsappWebClientState === "CONNECTED" 
            && chatwootMessage.inbox.id == process.env.WHATSAPP_WEB_CHATWOOT_INBOX_ID
            && chatwootMessage.message_type == "outgoing" 
            && !chatwootMessage.private) {
            const chatwootContact = await chatwootAPI.getChatwootContactById(chatwootMessage.conversation.contact_inbox.contact_id);
            const messages = await chatwootAPI.getChatwootConversationMessages(chatwootMessage.conversation.id);
            const messageData = messages.find((message:any) => {
                return message.id === chatwootMessage.id;
            });
            
            const to = `${chatwootContact.identifier}`;
            let formattedMessage:string = chatwootMessage.content;
            let messageContent:MessageContent;

            const chatwootMentions:RegExpMatchArray | null = formattedMessage.match(/@\w+/g);
            const options:any = {};
            
            if(chatwootMentions != null){
                const whatsappMentions:Array<Contact> = [];
                const groupChat:GroupChat = await whatsappWebClient.getChatById(to) as GroupChat;
                const groupParticipants:Array<GroupParticipant> = groupChat.participants;
                for (const mention of chatwootMentions) {
                    for(const participant of groupParticipants){
                        const mentionIdentifier = mention.substring(1).replace("+","");
                        const participantIdentifier = `${participant.id.user}@${participant.id.server}`;
                        const contact:Contact = await whatsappWebClient.getContactById(participantIdentifier);
                        if((contact.name != null && contact.name.includes(mentionIdentifier)) 
                        || contact.pushname.includes(mentionIdentifier)
                        || contact.number.includes(mentionIdentifier))
                            whatsappMentions.push(contact);
                    }
                }
                options.mentions = whatsappMentions;
            }

            if(process.env.PREFIX_AGENT_NAME_ON_MESSAGES == "true" && formattedMessage != null)
            {
                formattedMessage = `${chatwootMessage.sender?.name}: ${chatwootMessage.content}`;
            }
            
            if(messageData.attachments != null && messageData.attachments.length > 0)
            {
                const media = await MessageMedia.fromUrl(messageData.attachments[0].data_url);
                if(formattedMessage != null)
                {
                    options.caption = formattedMessage;
                }

                messageContent = media;
            }
            else
            {
                messageContent = formattedMessage;
            }
            whatsappWebClient.sendMessage(to, formattedMessage, options);
        }

        res.status(200).json({ result: "message_sent_succesfully" });
    } catch {
        res.status(400);
    }
});

//init api server
const server = expressApp.listen(process.env.PORT ?? "", () => {
    console.log(`API listening on ${process.env.PORT ?? ""}...`);
});

// add gracefull closing
process.on("SIGTERM", () => {
    console.log("SIGTERM signal received: closing HTTP server");
    server.close(() => {
        console.log("HTTP server closed");
    });
});

module.exports = expressApp;
