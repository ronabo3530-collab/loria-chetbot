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
//  GET /gmail-draft-bridge — "גשר" עבור ה-Bookmarklet ב-Gmail.
//  Gmail חוסמת (ב-CSP) קריאות ישירות מהדף שלה לשרתים חיצוניים, אז ה-Bookmarklet
//  פותח את הדף הקטן הזה בחלון נפרד (מהדומיין שלנו, לא כפוף למדיניות של Gmail),
//  שמבצע את הקריאה בעצמו ומעביר את התשובה בחזרה ל-Gmail דרך postMessage.
//  הסוד מוטבע כאן בצד השרת בלבד — לא נחשף ב-Bookmarklet הגלוי בדפדפן.
// ----------------------------------------------------------------------------
app.get("/gmail-draft-bridge", (_req, res) => {
  res.type("html").send(`<!doctype html>
<html lang="he" dir="rtl">
<head><meta charset="utf-8"><title>ליאור — גשר</title></head>
<body style="font-family:Arial,sans-serif;padding:20px;text-align:center;">
<div id="msg">מנסחת טיוטה... ⏳</div>
<script>
  var GMAIL_ORIGIN = "https://mail.google.com";
  var SECRET = ${JSON.stringify(DRAFT_SECRET || "")};

  function reply(type, data) {
    if (window.opener) {
      window.opener.postMessage(Object.assign({ type: type }, data), GMAIL_ORIGIN);
    }
  }

  window.addEventListener("message", function (e) {
    if (e.origin !== GMAIL_ORIGIN || !e.data || e.data.type !== "loria-draft-request") return;
    fetch("/api/draft-reply", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-draft-secret": SECRET },
      body: JSON.stringify({
        fromName: e.data.fromName,
        subject: e.data.subject,
        bodyText: e.data.bodyText,
      }),
    })
      .then(function (r) { return r.json(); })
      .then(function (data) {
        reply("loria-draft-result", { reply: data.reply || "" });
        document.getElementById("msg").innerText = "בוצע ✓ אפשר לסגור את החלון";
        setTimeout(function () { window.close(); }, 400);
      })
      .catch(function (err) {
        reply("loria-draft-error", { error: String(err) });
        document.getElementById("msg").innerText = "שגיאה: " + err;
      });
  });

  if (window.opener) {
    window.opener.postMessage({ type: "loria-bridge-ready" }, GMAIL_ORIGIN);
  } else {
    document.getElementById("msg").innerText = "יש לפתוח את הדף הזה דרך הכפתור ב-Gmail.";
  }
</script>
</body>
</html>`);
});

// ----------------------------------------------------------------------------
//  GET /gmail-draft-install — עמוד התקנה של ה-Bookmarklet.
//  במקום להעתיק-להדביק קוד ארוך לתיבת עריכת סימנייה (מועד לטעויות),
//  גוררים את הקישור ישירות לסרגל הסימניות — הדרך התקנית להתקין bookmarklet.
// ----------------------------------------------------------------------------
app.get("/gmail-draft-install", (_req, res) => {
  const bookmarklet =
    "javascript:(function () { var BRIDGE_URL = 'https://loria-chetbot-production.up.railway.app/gmail-draft-bridge'; var BRIDGE_ORIGIN = 'https://loria-chetbot-production.up.railway.app'; var subjectEl = document.querySelector('h2.hP'); var subject = subjectEl ? subjectEl.innerText : ''; var senderEl = document.querySelector('.gD'); var fromName = senderEl ? (senderEl.getAttribute('name') || senderEl.innerText || '') : ''; var bodies = document.querySelectorAll('.a3s.aiL'); var bodyEl = bodies.length ? bodies[bodies.length - 1] : null; var bodyText = bodyEl ? bodyEl.innerText : ''; if (!bodyText) { alert('לא הצלחתי למצוא מייל פתוח. ודא/י שמייל של לקוחה פתוח לקריאה ונסה/י שוב.'); return; } var composeBoxes = document.querySelectorAll('div[aria-label=\"Message Body\"], div[aria-label=\"גוף ההודעה\"]'); var compose = composeBoxes.length ? composeBoxes[composeBoxes.length - 1] : null; var old = document.getElementById('loriaDraftToast'); if (old) old.remove(); var toast = document.createElement('div'); toast.id = 'loriaDraftToast'; toast.style.cssText = 'position:fixed;bottom:24px;left:24px;z-index:2147483647;background:#075e54;color:#fff;padding:12px 20px;border-radius:10px;font-family:Arial,sans-serif;font-size:14px;box-shadow:0 4px 16px rgba(0,0,0,.3);direction:rtl;'; toast.innerText = 'ליאור מנסחת טיוטה... ⏳'; document.body.appendChild(toast); function showFallback(reply) { var overlay = document.createElement('div'); overlay.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,.5);z-index:2147483647;display:flex;align-items:center;justify-content:center;font-family:Arial,sans-serif;'; overlay.innerHTML = '<div style=\"background:#fff;padding:24px;border-radius:12px;max-width:520px;width:90%;direction:rtl;text-align:right;box-shadow:0 8px 30px rgba(0,0,0,.3);\">' + '<div style=\"font-weight:bold;margin-bottom:6px;font-size:15px;\">לא מצאתי תיבת תגובה פתוחה</div>' + '<div style=\"font-size:13px;color:#555;margin-bottom:12px;\">לחצ/י \"Reply\" במייל, ואז שוב על הכפתור. בינתיים הנה הטיוטה להעתקה:</div>' + '<textarea id=\"loriaDraftText\" readonly style=\"width:100%;height:200px;padding:10px;font-size:14px;direction:rtl;box-sizing:border-box;border:1px solid #ccc;border-radius:8px;font-family:Arial,sans-serif;\"></textarea>' + '<div style=\"margin-top:14px;display:flex;gap:8px;justify-content:flex-start;\">' + '<button id=\"loriaCopyBtn\" style=\"padding:10px 18px;background:#075e54;color:#fff;border:none;border-radius:8px;cursor:pointer;font-size:14px;\">העתקה</button>' + '<button id=\"loriaCloseBtn\" style=\"padding:10px 18px;background:#eee;border:none;border-radius:8px;cursor:pointer;font-size:14px;\">סגירה</button>' + '</div></div>'; document.body.appendChild(overlay); document.getElementById('loriaDraftText').value = reply; document.getElementById('loriaCloseBtn').onclick = function () { overlay.remove(); }; document.getElementById('loriaCopyBtn').onclick = function () { var ta = document.getElementById('loriaDraftText'); ta.select(); document.execCommand('copy'); document.getElementById('loriaCopyBtn').innerText = 'הועתק ✓'; }; } var bridge = window.open(BRIDGE_URL, 'loriaDraftBridge', 'width=380,height=160'); if (!bridge) { toast.innerText = 'הדפדפן חסם חלון קופץ — אשר/י חלונות קופצים לאתר הזה ונסה/י שוב.'; setTimeout(function () { toast.remove(); }, 6000); return; } var handled = false; function onMessage(e) { if (e.origin !== BRIDGE_ORIGIN || !e.data) return; if (e.data.type === 'loria-bridge-ready') { bridge.postMessage({ type: 'loria-draft-request', fromName: fromName, subject: subject, bodyText: bodyText }, BRIDGE_ORIGIN); return; } if (e.data.type === 'loria-draft-result') { handled = true; window.removeEventListener('message', onMessage); var reply = e.data.reply || ''; if (!reply) { toast.innerText = 'שגיאה: לא התקבלה תשובה מהשרת.'; setTimeout(function () { toast.remove(); }, 4000); return; } if (compose) { compose.focus(); var inserted = document.execCommand('insertText', false, reply); if (!inserted) compose.innerText = reply + '\\n\\n' + compose.innerText; toast.innerText = 'הטיוטה הוכנסה לתיבת התגובה ✓'; setTimeout(function () { toast.remove(); }, 3000); } else { toast.remove(); showFallback(reply); } } if (e.data.type === 'loria-draft-error') { handled = true; window.removeEventListener('message', onMessage); toast.innerText = 'שגיאת חיבור לשרת: ' + e.data.error; setTimeout(function () { toast.remove(); }, 5000); } } window.addEventListener('message', onMessage); setTimeout(function () { if (!handled) { window.removeEventListener('message', onMessage); toast.innerText = 'התהליך לקח יותר מדי זמן, נסה/י שוב.'; setTimeout(function () { toast.remove(); }, 4000); } }, 20000); })();";

  res.type("html").send(`<!doctype html>
<html lang="he" dir="rtl">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>התקנת כפתור ליאור ל-Gmail</title>
<style>
  body { font-family: Arial, sans-serif; max-width: 640px; margin: 40px auto; padding: 0 20px; line-height: 1.7; color: #222; }
  h1 { font-size: 22px; }
  .bookmarklet-btn { display: inline-block; background: #e91e63; color: #fff; padding: 14px 28px; border-radius: 10px;
    font-weight: bold; font-size: 16px; text-decoration: none; cursor: grab; box-shadow: 0 2px 8px rgba(0,0,0,.2); }
  .step { background: #f6f6f6; border-radius: 10px; padding: 16px 20px; margin: 16px 0; }
  code { background: #eee; padding: 2px 6px; border-radius: 4px; }
</style>
</head>
<body>
  <h1>✍️ התקנת כפתור "ליאור — טיוטת תשובה"</h1>
  <div class="step">
    <b>שלב 1:</b> ודאו שסרגל הסימניות מוצג בכרום (Ctrl+Shift+B אם הוא מוסתר).
  </div>
  <div class="step">
    <b>שלב 2:</b> גררו את הכפתור הוורוד הזה <u>ישירות</u> לסרגל הסימניות (לא ללחוץ עליו — לגרור אותו):
    <div style="text-align:center;margin-top:14px;">
      <a id="bmBtn" class="bookmarklet-btn" href="${bookmarklet}" onclick="return false;">✍️ ליאור — טיוטת תשובה</a>
    </div>
  </div>
  <div class="step">
    <b>שלב 3:</b> ב-Gmail: פתחו מייל של לקוחה ← לחצו <b>Reply</b> ← לחצו על הסימנייה שגררתם ← הטיוטה תופיע בתיבת התגובה ← בדקו ולחצו <b>Send</b>.
  </div>
  <p style="color:#888;font-size:13px;">
    לא הצליח לגרור? <a href="#" onclick="navigator.clipboard.writeText(document.getElementById('bmBtn').href).then(function(){alert('הקוד הועתק. צרו סימנייה חדשה בעצמכם (לחיצה ימנית על סרגל הסימניות ← Add page) והדביקו אותו בשדה ה-URL.');}); return false;">לחצו כאן להעתקת הקוד</a> והדביקו אותו ידנית בשדה ה-URL של סימנייה חדשה.
  </p>
</body>
</html>`);
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
