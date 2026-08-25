import express from "express";
import { getReply } from "./claude.js";
import { sendWhatsAppMessage, parseIncomingMessage } from "./whatsapp.js";
import { identity } from "./business-info.js";
import { logToSheet } from "./sheets.js";
import { draftEmailReply } from "./email-draft.js";

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;

// ----------------------------------------------------------------------------
//  זיכרון שיחה — נשמר בזיכרון (RAM) לפי מספר טלפון.
//  שומרים חלון של ההודעות האחרונות בלבד כדי לחסוך בעלות ובזמן.
//  ⚠️ בהפעלה מחדש של השרת הזיכרון מתאפס. לשלב מתקדם אפשר להחליף ל-Redis/DB.
// ----------------------------------------------------------------------------
const conversations = new Map();
const MAX_HISTORY = 10; // מספר ההודעות האחרונות שנשמרות (user+assistant)

function getHistory(phone) {
  return conversations.get(phone) ?? [];
}

function saveTurn(phone, userText, botText) {
  const history = getHistory(phone);
  history.push({ role: "user", content: userText });
  history.push({ role: "assistant", content: botText });
  // שומרים רק את החלון האחרון
  conversations.set(phone, history.slice(-MAX_HISTORY));
}

// ----------------------------------------------------------------------------
//  GET /webhook — אימות ה-webhook מול Meta (פעם אחת, בעת ההגדרה).
// ----------------------------------------------------------------------------
app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token === process.env.VERIFY_TOKEN) {
    console.log("✅ Webhook אומת בהצלחה");
    return res.status(200).send(challenge);
  }
  console.warn("❌ אימות webhook נכשל");
  return res.sendStatus(403);
});

// ----------------------------------------------------------------------------
//  POST /webhook — קבלת הודעות נכנסות מלקוחות.
// ----------------------------------------------------------------------------
app.post("/webhook", async (req, res) => {
  // עונים ל-Meta מיד (200) כדי שלא ישלחו שוב; מעבדים ברקע.
  res.sendStatus(200);

  const message = parseIncomingMessage(req.body);
  if (!message) return; // לא הודעה (עדכון סטטוס וכו')

  const { from, text, type, name } = message;

  try {
    // הודעה שאינה טקסט (תמונה/סטיקר/אודיו) — מבקשים בנימוס טקסט.
    if (!text) {
      await sendWhatsAppMessage(
        from,
        "היי, אני ליאור מצוות לוריה 🤍 כרגע אני יכולה לעזור עם הודעות טקסט — אפשר לכתוב לי את השאלה?"
      );
      return;
    }

    console.log(`📩 הודעה מ-${name ?? from}: ${text}`);

    const history = getHistory(from);
    const reply = await getReply(text, history);
    saveTurn(from, text, reply);

    await sendWhatsAppMessage(from, reply);
    console.log(`📤 תשובה נשלחה ל-${from}`);

    // תיעוד לגוגל שיטס — לא חוסם ולא מפיל את הבוט אם נכשל.
    logToSheet({ name, phone: from, userMessage: text, botReply: reply });
  } catch (err) {
    console.error("שגיאה בטיפול בהודעה:", err);
    try {
      await sendWhatsAppMessage(
        from,
        `אופס, קרתה תקלה קטנה 🙏 אפשר לנסות שוב עוד רגע? אם זה חוזר, אפשר לפנות אלינו במייל: ${identity.supportEmail}`
      );
    } catch {
      // אם גם השליחה נכשלה — כבר רשמנו את השגיאה למעלה.
    }
  }
});

// בדיקת בריאות פשוטה (שימושי לענן ולבדיקה בדפדפן).
app.get("/", (_req, res) => res.send("הבוט פעיל ✅"));

// ----------------------------------------------------------------------------
//  POST /api/draft-reply — מנסחת טיוטת תשובה למייל, רק לפי בקשה מפורשת
//  (כפתור ב-Gmail Add-on). לא אוטומטי, לא שולח כלום — רק מחזיר טקסט טיוטה.
//  מוגן במפתח סודי משותף כדי שלא כל אחד יוכל לקרוא לזה ולבזבז קרדיט Claude.
// ----------------------------------------------------------------------------
const DRAFT_SECRET = process.env.EMAIL_DRAFT_SECRET;

// CORS — מאפשר קריאה ל-endpoint הזה בלבד ממייל Gmail (לצורך ה-Bookmarklet).
// שאר ה-API לא נגיש מהדפדפן ממקורות אחרים.
function setDraftCors(res) {
  res.set("Access-Control-Allow-Origin", "https://mail.google.com");
  res.set("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.set("Access-Control-Allow-Headers", "Content-Type, x-draft-secret");
}

app.options("/api/draft-reply", (_req, res) => {
  setDraftCors(res);
  res.sendStatus(204);
});

app.post("/api/draft-reply", async (req, res) => {
  setDraftCors(res);
  if (!DRAFT_SECRET || req.get("x-draft-secret") !== DRAFT_SECRET) {
    return res.sendStatus(401);
  }
  try {
    const { fromName, subject, bodyText } = req.body || {};
    if (!bodyText || typeof bodyText !== "string") {
      return res.status(400).json({ error: "missing bodyText" });
    }
    const reply = await draftEmailReply({
      fromName: typeof fromName === "string" ? fromName.slice(0, 200) : "",
      subject: typeof subject === "string" ? subject.slice(0, 300) : "",
      bodyText: bodyText.slice(0, 6000),
    });
    res.json({ reply });
  } catch (err) {
    console.error("שגיאה בניסוח טיוטת מייל:", err);
    res.status(500).json({ error: "server error" });
  }
});

// ----------------------------------------------------------------------------
//  עמוד בדיקה 🧪 — צ'אט בדפדפן לבדיקת הבוט בלי וואטסאפ.
//  זמני: אפשר להסיר לפני העלייה לאוויר האמיתית.
// ----------------------------------------------------------------------------
app.post("/api/test-chat", async (req, res) => {
  try {
    const { message, history } = req.body || {};
    if (!message || typeof message !== "string") {
      return res.status(400).json({ error: "missing message" });
    }
    const safeHistory = Array.isArray(history) ? history.slice(-10) : [];
    const reply = await getReply(message.slice(0, 1000), safeHistory);
    res.json({ reply });
  } catch (err) {
    console.error("שגיאה בבדיקת צ'אט:", err);
    res.status(500).json({ error: "server error" });
  }
});

app.get("/chat", (_req, res) => {
  res.type("html").send(`<!doctype html>
<html lang="he" dir="rtl">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>בדיקת הבוט — ליאור של לוריה</title>
<style>
  * { box-sizing: border-box; }
  body { margin: 0; font-family: -apple-system, "Segoe UI", Rubik, Arial, sans-serif;
    background: #e5ddd5; height: 100dvh; display: flex; flex-direction: column; }
  header { background: #075e54; color: #fff; padding: 12px 16px; display: flex; align-items: center; gap: 10px; }
  header .avatar { width: 40px; height: 40px; border-radius: 50%; background: #25d366;
    display: grid; place-items: center; font-size: 20px; }
  header h1 { font-size: 16px; margin: 0; } header small { opacity: .8; font-size: 12px; }
  #chat { flex: 1; overflow-y: auto; padding: 16px; display: flex; flex-direction: column; gap: 8px; }
  .msg { max-width: 80%; padding: 8px 12px; border-radius: 10px; white-space: pre-wrap;
    word-wrap: break-word; line-height: 1.4; font-size: 15px; box-shadow: 0 1px 1px rgba(0,0,0,.1); }
  .bot { background: #fff; align-self: flex-start; border-top-right-radius: 2px; }
  .user { background: #dcf8c6; align-self: flex-end; border-top-left-radius: 2px; }
  .typing { color: #888; font-style: italic; }
  footer { display: flex; padding: 10px; gap: 8px; background: #f0f0f0; }
  #input { flex: 1; padding: 12px; border: none; border-radius: 22px; font-size: 15px; outline: none; }
  #send { background: #075e54; color: #fff; border: none; border-radius: 50%; width: 46px; height: 46px;
    font-size: 20px; cursor: pointer; flex-shrink: 0; }
  #send:disabled { opacity: .5; }
  .note { text-align: center; font-size: 12px; color: #777; padding: 6px; }
</style>
</head>
<body>
  <header>
    <div class="avatar">🤍</div>
    <div><h1>ליאור — לוריה</h1><small>עמוד בדיקה • לא וואטסאפ אמיתי</small></div>
  </header>
  <div id="chat"></div>
  <div class="note">💡 זו בדיקה פרטית שלך. כתבי לליאור כמו לקוחה אמיתית.</div>
  <footer>
    <input id="input" placeholder="כתוב/כתבי הודעה…" autocomplete="off">
    <button id="send">➤</button>
  </footer>
<script>
  const chat = document.getElementById("chat");
  const input = document.getElementById("input");
  const send = document.getElementById("send");
  const history = [];

  function bubble(text, who) {
    const d = document.createElement("div");
    d.className = "msg " + who;
    d.textContent = text;
    chat.appendChild(d);
    chat.scrollTop = chat.scrollHeight;
    return d;
  }

  async function ask() {
    const message = input.value.trim();
    if (!message) return;
    input.value = "";
    send.disabled = true;
    bubble(message, "user");
    const typing = bubble("ליאור כותבת…", "bot typing");
    try {
      const r = await fetch("/api/test-chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message, history }),
      });
      const data = await r.json();
      const reply = data.reply || "אירעה שגיאה 🙏";
      typing.remove();
      bubble(reply, "bot");
      history.push({ role: "user", content: message });
      history.push({ role: "assistant", content: reply });
    } catch (e) {
      typing.textContent = "שגיאת חיבור — נסה שוב";
    } finally {
      send.disabled = false;
      input.focus();
    }
  }

  send.onclick = ask;
  input.addEventListener("keydown", (e) => { if (e.key === "Enter") ask(); });
  bubble("היי, אני ליאור מצוות לוריה 🤍 איך אפשר לעזור לך היום?", "bot");
  input.focus();
</script>
</body>
</html>`);
});

app.listen(PORT, () => {
  console.log(`🚀 השרת רץ על פורט ${PORT}`);
});
