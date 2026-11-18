// ===== ตั้งค่าการเชื่อมต่อ Supabase =====
// เอาค่าจาก Supabase Dashboard → Project Settings → API Keys
//   SUPABASE_URL : Project URL เช่น https://abcdefgh.supabase.co
//   SUPABASE_KEY : Publishable key (ขึ้นต้นด้วย sb_publishable_...)  หรือ anon key แบบเดิม
// คีย์นี้เปิดเผยได้ (ข้อมูลถูกป้องกันด้วย Row Level Security ในฐานข้อมูล)
// ห้ามใส่ Secret key / service_role key ในไฟล์นี้เด็ดขาด
export const SUPABASE_URL = "https://xnzfbegojbgsvgguzkhp.supabase.co";
export const SUPABASE_KEY = "sb_publishable_9Twvo-RW9EjdyLVEaKPrAQ_ltbVefXo";
