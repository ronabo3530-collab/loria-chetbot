// מודול WhatsApp Cloud API — שליחה וקבלה של הודעות מול Meta Graph API.

const GRAPH_VERSION = "v21.0";

/**
 * שולח הודעת טקסט ללקוח דרך WhatsApp Cloud API.
 * @param {string} to - מספר הטלפון של הלקוח בפורמט בינלאומי (למשל 9725...)
 * @param {string} text - תוכן ההודעה
 */
export async function sendWhatsAppMessage(to, text) {
  const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID;
  const token = process.env.WHATSAPP_TOKEN;

  const url = `https://graph.facebook.com/${GRAPH_VERSION}/${phoneNumberId}/messages`;

  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      messaging_product: "whatsapp",
      to,
      type: "text",
      text: { body: text },
    }),
  });

  if (!res.ok) {
    const errBody = await res.text();
    console.error("שגיאה בשליחת הודעת וואטסאפ:", res.status, errBody);
    throw new Error(`WhatsApp API error: ${res.status}`);
  }

  return res.json();
}

/**
 * מפענח את גוף ה-webhook הנכנס מ-Meta ומחזיר את ההודעה הראשונה (אם קיימת).
 * מחזיר null אם זה לא אירוע הודעה (למשל עדכון סטטוס "נמסר/נקרא").
 * @returns {{ from: string, text: string|null, type: string, name: string|null } | null}
 */
export function parseIncomingMessage(body) {
  try {
    const entry = body.entry?.[0];
    const change = entry?.changes?.[0];
    const value = change?.value;
    const message = value?.messages?.[0];

    if (!message) return null; // עדכון סטטוס או אירוע אחר — לא הודעה

    const contactName = value?.contacts?.[0]?.profile?.name ?? null;

    return {
      from: message.from,
      type: message.type,
      // רק הודעות טקסט מכילות תוכן; לשאר (תמונה/סטיקר/אודיו) נחזיר null
      text: message.type === "text" ? message.text?.body ?? null : null,
      name: contactName,
    };
  } catch (err) {
    console.error("שגיאה בפענוח הודעה נכנסת:", err);
    return null;
  }
}
