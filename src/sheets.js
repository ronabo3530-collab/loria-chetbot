// תיעוד היסטוריית שיחות לגוגל שיטס — כדי שתוכלי לראות מה לקוחות שאלו ואיך ליאור ענתה.
// עובד מול Google Apps Script Web App (ראי הוראות הקמה ב-README) — לא דורש
// Google Cloud Console ולא OAuth, רק כתובת URL אחת.
// אם המשתנה לא מוגדר, או שהקריאה נכשלת — הבוט ממשיך לעבוד כרגיל בלי לקרוס.
const SHEETS_URL = process.env.GOOGLE_SHEETS_WEBHOOK_URL;

/**
 * שולחת תור שיחה אחד (הודעת לקוחה + תשובת הבוט) לגוגל שיטס.
 * לא חוסמת ולא זורקת שגיאה כלפי חוץ — כשל בתיעוד לא אמור להשפיע על השיחה עצמה.
 */
export async function logToSheet({ name, phone, userMessage, botReply }) {
  if (!SHEETS_URL) return;
  try {
    const res = await fetch(SHEETS_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: name ?? "", phone, userMessage, botReply }),
    });
    if (!res.ok) {
      console.error("שגיאה בתיעוד לגוגל שיטס:", res.status, await res.text());
    }
  } catch (err) {
    console.error("שגיאה בתיעוד לגוגל שיטס:", err);
  }
}
