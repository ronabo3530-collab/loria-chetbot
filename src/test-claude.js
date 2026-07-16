// סקריפט בדיקה מהיר ל-Claude — בלי וואטסאפ.
// מריצים עם:  npm run test:claude
// דורש שמשתנה הסביבה ANTHROPIC_API_KEY יהיה מוגדר (למשל דרך קובץ .env או בשורת הפקודה).
import { getReply } from "./claude.js";

// שאלות שבודקות גם את התשובות הקבועות וגם ייעוץ חופשי
const questions = [
  "היי, תוך כמה זמן מגיע המשלוח?",          // צריך להחזיר את התשובה הקבועה 1א מילה במילה
  "אילו אמצעי תשלום יש לכם? יש ביט?",        // תשובה קבועה 4
  "אני מתלבטת בין הדגמים, מה מתאים לאירוע?", // ייעוץ: חתולי
  "כמה עולה מארז אחד?",                       // 169 ₪
  "לא הצלחתי להרכיב את הריסים",               // תשובה קבועה 3 (סרטון)
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
