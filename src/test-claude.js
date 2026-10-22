// סקריפט בדיקה מהיר ל-Claude — בלי וואטסאפ.
// מריצים עם:  npm run test:claude
// דורש שמשתנה הסביבה ANTHROPIC_API_KEY יהיה מוגדר (למשל דרך קובץ .env או בשורת הפקודה).
import { getReply } from "./claude.js";

// שאלות שבודקות תשובות חופשיות, העברה למייל, קוד הנחה ומקרה רפואי
const questions = [
  "היי, זה כואב? אני מפחד שזה יפריע לי לישון",
  "כמה עולה מארז?",
  "יקר לי...",
  "ההזמנה שלי לא הגיעה כבר שבועיים",
  "יש לי דום נשימה, זה יעזור?",
  "אתם מוכרים גם מזרן אורתופדי?",
];

console.log("🧪 בודק את הבוט מול Claude...\n");

for (const q of questions) {
  console.log(`❓ ${q}`);
  try {
    const reply = await getReply(q, []);
    console.log(`🤖 ${reply}\n`);
  } catch (err) {
    console.error(`❌ שגיאה: ${err.message}\n`);
    console.error("ודא/י שמפתח ANTHROPIC_API_KEY מוגדר ותקין ושיש קרדיט בחשבון.");
    process.exit(1);
  }
}

console.log("✅ הבדיקה הסתיימה בהצלחה!");
