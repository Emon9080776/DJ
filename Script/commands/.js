import express from "express";
import bodyParser from "body-parser";
import fetch from "node-fetch";
import dotenv from "dotenv";

dotenv.config();
const app = express();
app.use(bodyParser.json());

const VERIFY_TOKEN = process.env.VERIFY_TOKEN;
const PAGE_TOKEN = process.env.PAGE_TOKEN;
const OPENAI_KEY  = process.env.OPENAI_KEY;
const VOICE_SAMPLE_URL = process.env.VOICE_SAMPLE_URL || ""; // optional

// In-memory user memory (simple)
const userProfiles = new Map(); // psid => { name, lastSeen }

// --- Helpers ---
async function callSendAPI(body) {
  const url = `https://graph.facebook.com/v20.0/me/messages?access_token=${PAGE_TOKEN}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  if (!res.ok) {
    const txt = await res.text();
    console.error("Send API error:", txt);
  }
}

async function sendText(psid, text) {
  await callSendAPI({ recipient: { id: psid }, messaging_type: "RESPONSE", message: { text } });
}

async function sendQuickReply(psid, text, replies) {
  await callSendAPI({
    recipient: { id: psid },
    messaging_type: "RESPONSE",
    message: {
      text,
      quick_replies: replies.map(r => ({
        content_type: "text",
        title: r.title,
        payload: r.payload
      }))
    }
  });
}

async function sendButtons(psid, text, buttons) {
  await callSendAPI({
    recipient: { id: psid },
    messaging_type: "RESPONSE",
    message: {
      attachment: {
        type: "template",
        payload: {
          template_type: "button",
          text,
          buttons
        }
      }
    }
  });
}

async function sendImage(psid, imageUrl) {
  await callSendAPI({
    recipient: { id: psid },
    message: {
      attachment: {
        type: "image",
        payload: { url: imageUrl, is_reusable: true }
      }
    }
  });
}

async function sendAudio(psid, audioUrl) {
  await callSendAPI({
    recipient: { id: psid },
    message: {
      attachment: {
        type: "audio",
        payload: { url: audioUrl }
      }
    }
  });
}

// --- Simple safe flirty prompts (Bangla + English mix, no adult) ---
const SAFE_IMAGE_POOL = [
  "https://images.unsplash.com/photo-1500530855697-b586d89ba3ee?q=80&w=1200&auto=format",
  "https://images.unsplash.com/photo-1511988617509-a57c8a288659?q=80&w=1200&auto=format",
  "https://images.unsplash.com/photo-1500534314209-a25ddb2bd429?q=80&w=1200&auto=format"
];

function systemPrompt(name = "প্রিয়") {
  return `
You are a cute, flirty but SFW Bengali-English mixed chatbot.
Style: playful, sweet, romantic hints, emojis. Never explicit or adult.
Always keep replies short (1–3 sentences) and positive.
If user asks your name, say: "আমি SweetMix Bot 💖".
User's name: ${name}.
Use Bangla base with a little English spice.
`;
}

// --- OpenAI (Chat Completions) ---
async function aiReply(content, name) {
  const payload = {
    model: "gpt-3.5-turbo",
    messages: [
      { role: "system", content: systemPrompt(name) },
      { role: "user", content }
    ],
    max_tokens: 120,
    temperature: 0.9
  };

  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${OPENAI_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(payload)
  });

  const data = await res.json();
  return data?.choices?.[0]?.message?.content?.trim() || "Hmm, say that again na? 😊";
}

// =============== WEBHOOK VERIFY ===============
app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];
  if (mode === "subscribe" && token === VERIFY_TOKEN) {
    return res.status(200).send(challenge);
  }
  return res.sendStatus(403);
});

// =============== RECEIVE EVENTS ===============
app.post("/webhook", async (req, res) => {
  try {
    if (req.body.object === "page") {
      for (const entry of req.body.entry) {
        const event = entry.messaging?.[0];
        if (!event) continue;
        const psid = event.sender.id;

        // Postbacks (buttons)
        if (event.postback?.payload) {
          await handlePostback(psid, event.postback.payload);
          continue;
        }

        // Messages
        if (event.message) {
          // capture user name from "আমার নাম ..." / "my name is ..."
          const text = (event.message.text || "").trim();
          if (text) {
            await handleText(psid, text);
          } else if (event.message.attachments?.length) {
            await sendText(psid, "Nice! Got your attachment 😄");
          }
        }
      }
      return res.sendStatus(200);
    }
    res.sendStatus(404);
  } catch (e) {
    console.error(e);
    res.sendStatus(500);
  }
});

// =============== HANDLERS ===============
async function handleText(psid, text) {
  // memory
  const profile = userProfiles.get(psid) || { name: null, lastSeen: Date.now() };

  const lower = text.toLowerCase();

  // onboarding
  if (!profile.name) {
    // small name capture heuristics
    if (/(my name is|আমার নাম|আমার নামটা|i am)\s+/i.test(text)) {
      const captured = text.split(/my name is|আমার নাম|i am/i).pop().trim().split(/[.,!]/)[0];
      profile.name = captured.slice(0, 30);
      userProfiles.set(psid, profile);
      await sendQuickReply(psid, `Cute name, ${profile.name}! 💖 Shall we start?`, [
        { title: "Show Menu", payload: "MENU" },
        { title: "Send Image", payload: "IMAGE" }
      ]);
      return;
    } else {
      await sendQuickReply(psid,
        "Hey! তোমার নাম কী? (Type: ‘আমার নাম …’ or ‘My name is …’)",
        [{ title: "Skip", payload: "SKIP_NAME" }]
      );
      return;
    }
  }

  // basic intents
  if (["menu", "মেনু"].some(k => lower.includes(k))) {
    await showMenu(psid);
    return;
  }
  if (["time", "সময়", "সময়"].some(k => lower.includes(k))) {
    const now = new Date();
    await sendText(psid, `Time now: ${now.toLocaleTimeString()} ⏰`);
    return;
  }
  if (["date", "তারিখ"].some(k => lower.includes(k))) {
    const now = new Date();
    await sendText(psid, `Date: ${now.toLocaleDateString()} 📅`);
    return;
  }
  if (["image", "ইমেজ", "photo", "ছবি"].some(k => lower.includes(k))) {
    const pic = SAFE_IMAGE_POOL[Math.floor(Math.random() * SAFE_IMAGE_POOL.length)];
    await sendImage(psid, pic);
    return;
  }
  if (["voice", "ভয়েস", "ভয়েস", "audio"].some(k => lower.includes(k))) {
    if (VOICE_SAMPLE_URL) {
      await sendAudio(psid, VOICE_SAMPLE_URL);
    } else {
      await sendText(psid, "Set VOICE_SAMPLE_URL in .env to send voice notes 🎙️");
    }
    return;
  }

  // AI reply (flirty, safe, bn-en)
  const name = profile.name || "প্রিয়";
  const reply = await aiReply(text, name);

  // 20% time also send a cute image with text
  if (Math.random() < 0.2) {
    await sendText(psid, reply);
    const pic = SAFE_IMAGE_POOL[Math.floor(Math.random() * SAFE_IMAGE_POOL.length)];
    await sendImage(psid, pic);
  } else {
    // sometimes send buttons to engage
    if (Math.random() < 0.25) {
      await sendButtons(psid, reply, [
        { type: "postback", title: "Send Image 📸", payload: "IMAGE" },
        { type: "postback", title: "Voice Note 🎙️", payload: "VOICE" }
      ]);
    } else {
      await sendText(psid, reply);
    }
  }

  profile.lastSeen = Date.now();
  userProfiles.set(psid, profile);
}

async function handlePostback(psid, payload) {
  const profile = userProfiles.get(psid) || { name: null, lastSeen: Date.now() };

  switch (payload) {
    case "MENU":
      await showMenu(psid);
      break;
    case "IMAGE":
      await sendImage(psid, SAFE_IMAGE_POOL[Math.floor(Math.random() * SAFE_IMAGE_POOL.length)]);
      break;
    case "VOICE":
      if (VOICE_SAMPLE_URL) {
        await sendAudio(psid, VOICE_SAMPLE_URL);
      } else {
        await sendText(psid, "Set VOICE_SAMPLE_URL in .env to send voice notes 🎙️");
      }
      break;
    case "SKIP_NAME":
      profile.name = "প্রিয়";
      userProfiles.set(psid, profile);
      await sendText(psid, "Alright! I’ll call you প্রিয় 💖");
      await showMenu(psid);
      break;
    default:
      await sendText(psid, "Got it! 😊");
  }
}

async function showMenu(psid) {
  await sendQuickReply(psid, "Pick one, sweetie 💞", [
    { title: "Cute Text", payload: "CUTE" },
    { title: "Send Image", payload: "IMAGE" },
    { title: "Voice Note", payload: "VOICE" },
  ]);
}

// Root
app.get("/", (_req, res) => res.send("SweetMix Messenger Bot is running 💖"));

app.listen(process.env.PORT || 3000, () => {
  console.log(`🚀 Bot up on :${process.env.PORT || 3000}`);
});
