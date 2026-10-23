import express from "express";
import { getReply } from "./claude.js";
import { sendWhatsAppMessage, parseIncomingMessage } from "./whatsapp.js";
import { identity } from "./business-info.js";
import { logToSheet } from "./sheets.js";
import { getHistory, saveTurn } from "./conversations.js";
import { startAbandonedCartRecovery } from "./abandoned-cart.js";

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;

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

  const { from, text, type, name, phoneNumberId } = message;

  // הגנה: עונים רק להודעות שהגיעו למספר העסקי של MILOA. אם אפליקציית ה-Meta עדיין
  // מחוברת גם למספר אחר (למשל של העסק הקודם) — מתעלמים, כדי שלא נענה מהמספר הלא נכון.
  const ownPhoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID;
  if (ownPhoneNumberId && phoneNumberId && phoneNumberId !== ownPhoneNumberId) {
    console.warn(`⚠️ הודעה למספר אחר (${phoneNumberId}) — מתעלם.`);
    return;
  }

  try {
    // הודעה שאינה טקסט (תמונה/סטיקר/אודיו) — מבקשים בנימוס טקסט.
    if (!text) {
      await sendWhatsAppMessage(
        from,
        "היי, אני רועי מצוות MILOA 🙂 כרגע אפשר לעזור בהודעות טקסט בלבד, אפשר לכתוב לי את השאלה?"
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
<title>בדיקת הבוט — רועי של MILOA</title>
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
    <div><h1>רועי — MILOA</h1><small>עמוד בדיקה • לא וואטסאפ אמיתי</small></div>
  </header>
  <div id="chat"></div>
  <div class="note">💡 זו בדיקה פרטית שלך. כתבו לרועי כמו לקוח אמיתי.</div>
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
    const typing = bubble("רועי כותב…", "bot typing");
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
  bubble("היי, אני רועי מצוות MILOA 🙂 איך אפשר לעזור היום?", "bot");
  input.focus();
</script>
</body>
</html>`);
});

app.listen(PORT, () => {
  console.log(`🚀 השרת רץ על פורט ${PORT}`);
  startAbandonedCartRecovery();
});
