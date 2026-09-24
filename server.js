const express = require('express');
const cors = require('cors');
require('dotenv').config();
const { neon } = require('@neondatabase/serverless');
const app = express();
app.use(express.json());
app.use(cors());
const sql = neon(process.env.DATABASE_URL);
async function initDB(){
 try{
  await sql`SELECT NOW()`;
  await sql`CREATE TABLE IF NOT EXISTS users (id SERIAL PRIMARY KEY, phone VARCHAR(20) UNIQUE NOT NULL, name VARCHAR(100), pin VARCHAR(100), balance DECIMAL DEFAULT 0, created_at TIMESTAMP DEFAULT NOW())`;
  await sql`CREATE TABLE IF NOT EXISTS transactions (id SERIAL PRIMARY KEY, phone VARCHAR(20), amount DECIMAL, type VARCHAR(20), mpesa_code VARCHAR(50), created_at TIMESTAMP DEFAULT NOW())`;
  console.log("DB ready");
 }catch(e){console.error("DB FAIL", e)}
}
initDB();
app.post("/api/send", async (req,res)=>{
 try{
  let {fromPhone,toPhone,amount}=req.body;
  amount=Number(amount);
  fromPhone=fromPhone.toString().replace(/^0/,'254').replace(/^\+/,'');
  if(fromPhone.startsWith('07')) fromPhone='254'+fromPhone.slice(1);
  toPhone=toPhone.toString().replace(/^0/,'254').replace(/^\+/,'');
  if(toPhone.startsWith('07')) toPhone='254'+toPhone.slice(1);
  await sql`INSERT INTO users (phone,balance) VALUES (${fromPhone},1000) ON CONFLICT (phone) DO NOTHING`;
  await sql`INSERT INTO users (phone,balance) VALUES (${toPhone},0) ON CONFLICT (phone) DO NOTHING`;
  await sql`UPDATE users SET balance = balance - ${amount} WHERE phone=${fromPhone}`;
  await sql`UPDATE users SET balance = balance + ${amount} WHERE phone=${toPhone}`;
  await sql`INSERT INTO transactions (phone, amount, type, mpesa_code) VALUES (${fromPhone}, ${-amount}, 'send', ${'jpay-'+Date.now()})`;
  await sql`INSERT INTO transactions (phone, amount, type, mpesa_code) VALUES (${toPhone}, ${amount}, 'receive', ${'jpay-'+Date.now()})`;
  res.json({success:true, message:`Sent ${amount} to ${toPhone}`});
 }catch(e){console.error(e); res.status(500).json({error:e.message})}
});
app.get('/',(req,res)=>res.send('JPay V9 Neon fixed'));
app.get('/balance/:phone', async (req,res)=>{
 try{
  let phone=req.params.phone.replace(/^0/,'254').replace(/^\+/,'');
  if(phone.startsWith('07')) phone='254'+phone.slice(1);
  const r=await sql`SELECT * FROM users WHERE phone=${phone}`;
  if(!r[0]) return res.status(404).json({error:'User not found'});
  res.json(r[0]);
 }catch(e){res.json({error:e.message})}
});
app.post('/api/register', async (req,res)=>{
 try{
  let {phone,name,pin}=req.body;
  phone=phone.replace(/^0/,'254').replace(/^\+/,'');
  if(phone.startsWith('07')) phone='254'+phone.slice(1);
  const r=await sql`INSERT INTO users (phone,name,pin,balance) VALUES (${phone},${name},${pin},1000) ON CONFLICT (phone) DO UPDATE SET name=${name},pin=${pin} RETURNING *`;
  res.json({success:true,user:r[0]});
 }catch(e){res.json({error:e.message})}
});
const PORT=process.env.PORT||10000;
app.listen(PORT,()=>console.log(`JPay live on ${PORT}`));
module.exports=app;
