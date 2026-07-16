import express from "express";
import { getReply } from "./claude.js";
import { sendWhatsAppMessage, parseIncomingMessage } from "./whatsapp.js";

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
  } catch (err) {
    console.error("שגיאה בטיפול בהודעה:", err);
    try {
      await sendWhatsAppMessage(
        from,
        "אופס, קרתה תקלה קטנה 🙏 אפשר לנסות שוב עוד רגע? אם זה חוזר, אפשר לפנות אלינו במייל shopbyloria@gmail.com"
      );
    } catch {
      // אם גם השליחה נכשלה — כבר רשמנו את השגיאה למעלה.
    }
  }
});

// בדיקת בריאות פשוטה (שימושי לענן ולבדיקה בדפדפן).
app.get("/", (_req, res) => res.send("הבוט פעיל ✅"));

app.listen(PORT, () => {
  console.log(`🚀 השרת רץ על פורט ${PORT}`);
});
