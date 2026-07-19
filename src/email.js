// מענה אוטומטי למיילים של לקוחות + תיוג מיילים שדולגו (פרסומות/ספאם/לא רלוונטי).
// עובד ב"בדיקה מחזורית" (polling) — כל כמה דקות בודק הודעות חדשות בתיבה, לא
// דורש Google Cloud Console ולא OAuth: רק חשבון + סיסמת אפליקציה (App Password).
// אם EMAIL_USER / EMAIL_APP_PASSWORD לא מוגדרים — התכונה כבויה, הבוט ממשיך לעבוד רגיל.
import { ImapFlow } from "imapflow";
import { simpleParser } from "mailparser";
import nodemailer from "nodemailer";
import { identity } from "./business-info.js";
import { getEmailReply } from "./email-claude.js";

const EMAIL_USER = process.env.EMAIL_USER;
const EMAIL_APP_PASSWORD = process.env.EMAIL_APP_PASSWORD;
const POLL_INTERVAL_MS = 2 * 60 * 1000; // בדיקת תיבה כל 2 דקות

const SKIPPED_LABEL = "דולג ע\"י הבוט";
const ANSWERED_LABEL = "נענה ע\"י הבוט";

// שימוש ב-STARTTLS על פורט 587 במפורש (במקום TLS ישיר על 465) — חלק מספקי הענן
// חוסמים/מתקשים עם פורט 465, ו-587 נתמך הרבה יותר טוב ברשתות מוגבלות.
const transporter =
  EMAIL_USER && EMAIL_APP_PASSWORD
    ? nodemailer.createTransport({
        host: "smtp.gmail.com",
        port: 587,
        secure: false,
        requireTLS: true,
        auth: { user: EMAIL_USER, pass: EMAIL_APP_PASSWORD },
        connectionTimeout: 20000,
      })
    : null;

// סינון חינמי (בלי לקרוא ל-Claude בכלל) — תופס את רוב הספאם/הפרסומות בלי שום עלות.
function looksAutomated(fromAddress, parsed) {
  const addr = (fromAddress || "").toLowerCase();
  if (/no-?reply|mailer-daemon|do-?not-?reply|postmaster/.test(addr)) return true;
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
        await transporter.sendMail({
          from: `"${identity.botName} מלוריה" <${EMAIL_USER}>`,
          to: fromAddress,
          subject: /^re:/i.test(subject) ? subject : `Re: ${subject}`,
          text: reply,
          inReplyTo: parsed.messageId,
          references: parsed.messageId,
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

  console.log(`📧 מענה אוטומטי למייל פעיל עבור ${EMAIL_USER} (בדיקה כל ${POLL_INTERVAL_MS / 60000} דקות)`);

  const poll = () => {
    processInbox().catch((err) => console.error("שגיאה כללית בבדיקת תיבת המייל:", err));
  };

  poll(); // בדיקה ראשונה מיד עם עליית השרת
  setInterval(poll, POLL_INTERVAL_MS);
}
