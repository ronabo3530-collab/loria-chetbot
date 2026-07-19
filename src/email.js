// מענה אוטומטי למיילים של לקוחות + תיוג מיילים שדולגו (פרסומות/ספאם/לא רלוונטי).
// קריאה: IMAP + סיסמת אפליקציה (App Password), כמו קודם. שליחה: Gmail API
// (HTTPS) במקום SMTP גולמי — Railway (וכל ספקי הענן בפועל) חוסמים את פורטי
// ה-SMTP (465/587) ברמת הרשת כדי למנוע ניצול לספאם, אז שליחה חייבת לעבור HTTPS.
// אם EMAIL_USER / EMAIL_APP_PASSWORD לא מוגדרים — התכונה כבויה, הבוט ממשיך לעבוד רגיל.
import { ImapFlow } from "imapflow";
import { simpleParser } from "mailparser";
import { identity } from "./business-info.js";
import { getEmailReply } from "./email-claude.js";
import { sendGmailMessage, isGmailApiConfigured } from "./gmail-send.js";

const EMAIL_USER = process.env.EMAIL_USER;
const EMAIL_APP_PASSWORD = process.env.EMAIL_APP_PASSWORD;
const POLL_INTERVAL_MS = 2 * 60 * 1000; // בדיקת תיבה כל 2 דקות

const SKIPPED_LABEL = "דולג ע\"י הבוט";
const ANSWERED_LABEL = "נענה ע\"י הבוט";

// דומיינים של שירותים/אפליקציות מחוברות (Shopify, סליקה, אפליקציות חנות וכו') —
// אף לקוחה אמיתית לא כותבת מכתובת כזו, אז אין טעם לשלם ל-Claude כדי לסנן אותן.
const AUTOMATED_DOMAINS = [
  "shopify.com",
  "shopifyemail.com",
  "paypal.com",
  "paypal.co.il",
  "loox.app",
  "advansoftware.com", // Kip
  "winwinshop.app",
  "stripe.com",
  "canva.com",
  "tiktok.com",
  "facebook.com",
  "facebookmail.com",
];

// סינון חינמי (בלי לקרוא ל-Claude בכלל) — תופס את רוב הספאם/ההודעות האוטומטיות בלי שום עלות.
function looksAutomated(fromAddress, parsed) {
  const addr = (fromAddress || "").toLowerCase();
  if (/no-?reply|mailer-daemon|do-?not-?reply|postmaster/.test(addr)) return true;
  const domain = addr.split("@")[1] || "";
  if (AUTOMATED_DOMAINS.some((d) => domain === d || domain.endsWith(`.${d}`))) return true;
  if (parsed.headers?.has?.("list-unsubscribe")) return true;
  const precedence = parsed.headers?.get?.("precedence");
  if (precedence && /bulk|junk|list/i.test(String(precedence))) return true;
  return false;
}

// יוצרת תווית/תיקייה בג'ימייל אם עוד לא קיימת (מתעלמת משגיאה אם כבר קיימת).
async function ensureLabel(client, label) {
  try {
    await client.mailboxCreate(label);
  } catch {
    // כבר קיימת - בסדר גמור
  }
}

async function processInbox() {
  const client = new ImapFlow({
    host: "imap.gmail.com",
    port: 993,
    secure: true,
    auth: { user: EMAIL_USER, pass: EMAIL_APP_PASSWORD },
    logger: false,
  });

  await client.connect();
  const lock = await client.getMailboxLock("INBOX");

  try {
    const uids = await client.search({ seen: false }, { uid: true });
    if (!uids || !uids.length) return;

    for (const uid of uids) {
      let parsed;
      try {
        const msg = await client.fetchOne(String(uid), { source: true }, { uid: true });
        if (!msg || !msg.source) continue;
        parsed = await simpleParser(msg.source);
      } catch (err) {
        console.error("שגיאה בפענוח מייל נכנס:", err);
        continue;
      }

      // מסמנים כנקרא מיד, כדי לא לעבד שוב את אותו מייל בבדיקה הבאה.
      await client.messageFlagsAdd(String(uid), ["\\Seen"], { uid: true });

      const fromAddress = parsed.from?.value?.[0]?.address || "";
      const fromName = parsed.from?.value?.[0]?.name || fromAddress;
      const subject = parsed.subject || "";
      const bodyText = (parsed.text || "").trim();

      if (!fromAddress || !bodyText) continue;

      if (looksAutomated(fromAddress, parsed)) {
        console.log(`⏭️ מייל אוטומטי/פרסומת דולג (סינון חינמי): ${fromAddress}`);
        continue;
      }

      let reply;
      try {
        reply = await getEmailReply({ fromName, subject, bodyText });
      } catch (err) {
        console.error("שגיאה בקבלת תשובה מ-Claude למייל:", err);
        continue;
      }

      if (!reply) {
        console.log(`⏭️ סוּנן ע"י הבוט (לא שאלת לקוחה אמיתית): ${fromAddress} — ${subject}`);
        await ensureLabel(client, SKIPPED_LABEL);
        try {
          await client.messageCopy(String(uid), SKIPPED_LABEL, { uid: true });
        } catch (err) {
          console.error("שגיאה בתיוג מייל שדולג:", err);
        }
        continue;
      }

      try {
        await sendGmailMessage({
          fromName: `${identity.botName} מלוריה`,
          fromAddress: EMAIL_USER,
          to: fromAddress,
          subject: /^re:/i.test(subject) ? subject : `Re: ${subject}`,
          text: reply,
          inReplyTo: parsed.messageId,
        });
        console.log(`📤 נשלחה תשובת מייל ל-${fromAddress}`);
        await ensureLabel(client, ANSWERED_LABEL);
        await client.messageCopy(String(uid), ANSWERED_LABEL, { uid: true });
      } catch (err) {
        console.error("שגיאה בשליחת תשובת מייל:", err);
      }
    }
  } finally {
    lock.release();
    await client.logout().catch(() => {});
  }
}

/**
 * מפעילה בדיקת תיבת מייל מחזורית. לא עושה כלום אם המשתנים לא מוגדרים.
 */
export function startEmailPolling() {
  if (!EMAIL_USER || !EMAIL_APP_PASSWORD) {
    console.log("ℹ️ מענה אוטומטי למייל לא מוגדר (EMAIL_USER/EMAIL_APP_PASSWORD חסרים) — מדלגים.");
    return;
  }
  if (!isGmailApiConfigured()) {
    console.log("ℹ️ מענה אוטומטי למייל לא מוגדר (GMAIL_CLIENT_ID/GMAIL_CLIENT_SECRET/GMAIL_REFRESH_TOKEN חסרים) — מדלגים.");
    return;
  }

  console.log(`📧 מענה אוטומטי למייל פעיל עבור ${EMAIL_USER} (בדיקה כל ${POLL_INTERVAL_MS / 60000} דקות)`);

  const poll = () => {
    processInbox().catch((err) => console.error("שגיאה כללית בבדיקת תיבת המייל:", err));
  };

  poll(); // בדיקה ראשונה מיד עם עליית השרת
  setInterval(poll, POLL_INTERVAL_MS);
}
