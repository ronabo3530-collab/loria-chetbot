// שליחת מייל דרך Gmail API (REST, מעל HTTPS) במקום SMTP גולמי.
// SMTP (פורטים 465/587) חסום ברמת הרשת ב-Railway (ומרבית ספקי הענן) כדי למנוע
// ניצול לספאם, ולכן אין דרך לתקן זאת בקוד — הפתרון היחיד הוא לעבור לפרוטוקול
// HTTP/HTTPS. Gmail API עם OAuth2 (client_id + client_secret + refresh_token
// שהופקו פעם אחת ב-Google Cloud Console) שולח כ-shopbyloria@gmail.com בפועל.
const GMAIL_CLIENT_ID = process.env.GMAIL_CLIENT_ID;
const GMAIL_CLIENT_SECRET = process.env.GMAIL_CLIENT_SECRET;
const GMAIL_REFRESH_TOKEN = process.env.GMAIL_REFRESH_TOKEN;

function encodeMimeWord(text) {
  return `=?UTF-8?B?${Buffer.from(text, "utf-8").toString("base64")}?=`;
}

function toBase64Url(buffer) {
  return buffer
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function buildRawMessage({ fromName, fromAddress, toAddress, subject, bodyText, inReplyTo }) {
  const headers = [
    `From: ${encodeMimeWord(fromName)} <${fromAddress}>`,
    `To: ${toAddress}`,
    `Subject: ${encodeMimeWord(subject)}`,
    inReplyTo ? `In-Reply-To: ${inReplyTo}` : null,
    inReplyTo ? `References: ${inReplyTo}` : null,
    "MIME-Version: 1.0",
    'Content-Type: text/plain; charset="UTF-8"',
    "Content-Transfer-Encoding: 8bit",
  ]
    .filter(Boolean)
    .join("\r\n");

  return toBase64Url(Buffer.from(`${headers}\r\n\r\n${bodyText}`, "utf-8"));
}

async function getAccessToken() {
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: GMAIL_CLIENT_ID,
      client_secret: GMAIL_CLIENT_SECRET,
      refresh_token: GMAIL_REFRESH_TOKEN,
      grant_type: "refresh_token",
    }),
  });
  if (!res.ok) {
    throw new Error(`רענון טוקן Gmail נכשל (${res.status}): ${await res.text()}`);
  }
  const data = await res.json();
  return data.access_token;
}

/**
 * שולחת מייל בשם shopbyloria@gmail.com דרך Gmail API.
 * @param {{ fromName: string, fromAddress: string, to: string, subject: string, text: string, inReplyTo?: string }} params
 */
export async function sendGmailMessage({ fromName, fromAddress, to, subject, text, inReplyTo }) {
  const accessToken = await getAccessToken();
  const raw = buildRawMessage({
    fromName,
    fromAddress,
    toAddress: to,
    subject,
    bodyText: text,
    inReplyTo,
  });

  const res = await fetch("https://gmail.googleapis.com/gmail/v1/users/me/messages/send", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ raw }),
  });

  if (!res.ok) {
    throw new Error(`שליחת מייל דרך Gmail API נכשלה (${res.status}): ${await res.text()}`);
  }
}

export function isGmailApiConfigured() {
  return Boolean(GMAIL_CLIENT_ID && GMAIL_CLIENT_SECRET && GMAIL_REFRESH_TOKEN);
}
