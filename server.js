const express = require('express');
const cors = require('cors');
const path = require('path');
require('dotenv').config();
const { neon } = require('@neondatabase/serverless');

const app = express();
app.use(express.json());
app.use(cors());
app.use(express.static(path.join(__dirname, 'public')));

const sql = neon(process.env.DATABASE_URL);

async function initDB(){
 try{
  await sql`CREATE TABLE IF NOT EXISTS users (id SERIAL PRIMARY KEY, phone VARCHAR(20) UNIQUE NOT NULL, name VARCHAR(100) DEFAULT 'JPay User', pin VARCHAR(100), balance DECIMAL DEFAULT 1000, created_at TIMESTAMP DEFAULT NOW())`;
  await sql`CREATE TABLE IF NOT EXISTS transactions (id SERIAL PRIMARY KEY, from_user_id INT, to_user_id INT, phone VARCHAR(20), amount DECIMAL, type VARCHAR(20), mpesa_code VARCHAR(50), created_at TIMESTAMP DEFAULT NOW())`;
  console.log("DB ready");
 }catch(e){console.error("DB FAIL", e)}
}
initDB();

function norm(phone){
  if(!phone) return '';
  let p = phone.toString().replace(/\s/g,'').replace(/^\+/,'');
  if(p.startsWith('254')) return p;
  if(p.startsWith('07')) p = '254'+p.slice(1);
  else if(p.startsWith('0')) p = '254'+p.slice(1);
  else if(p.startsWith('7') && p.length==9) p='254'+p;
  return p;
}

app.get('/', (req,res)=>{
  res.sendFile(path.join(__dirname, 'public', 'dashboard.html'));
});

app.get('/api/user/:phone', async (req,res)=>{
 try{
  const phone=norm(req.params.phone);
  const pin=req.query.pin;
  const users=await sql`SELECT * FROM users WHERE phone=${phone}`;
  if(!users[0]) return res.json({error:'User not found. Register first.'});
  if(pin && users[0].pin && users[0].pin!==pin) return res.json({error:'Wrong PIN'});
  const tx=await sql`SELECT * FROM transactions WHERE phone=${phone} OR from_user_id=${users[0].id} OR to_user_id=${users[0].id} ORDER BY created_at DESC LIMIT 20`;
  res.json({user:users[0], transactions:tx});
 }catch(e){res.json({error:e.message})}
});

app.get('/balance/:phone', async (req,res)=>{
 try{
  const phone=norm(req.params.phone);
  const r=await sql`SELECT * FROM users WHERE phone=${phone}`;
  if(!r[0]) return res.json({error:'User not found'});
  res.json(r[0]);
 }catch(e){res.json({error:e.message})}
});

app.post('/api/register', async (req,res)=>{
 try{
  let {phone,name,pin}=req.body;
  phone=norm(phone);
  if(!phone || phone.length < 12) return res.json({error:'Invalid phone'});
  const r=await sql`INSERT INTO users (phone,name,pin,balance) VALUES (${phone},${name||'JPay User'},${pin||'1234'},1000) ON CONFLICT (phone) DO UPDATE SET name=EXCLUDED.name, pin=EXCLUDED.pin RETURNING *`;
  res.json({success:true,user:r[0]});
 }catch(e){res.json({error:e.message})}
});

app.post('/transfer', async (req,res)=>{
 try{
  let {from_phone,to_phone,amount,pin}=req.body;
  amount=Number(amount);
  if(!amount || amount<=0) return res.json({error:'Invalid amount'});
  from_phone=norm(from_phone); to_phone=norm(to_phone);
  if(from_phone===to_phone) return res.json({error:'Cannot send to yourself'});

  const fromU=await sql`SELECT * FROM users WHERE phone=${from_phone}`;
  if(!fromU[0]) return res.json({error:'Sender not found'});
  if(fromU[0].pin && fromU[0].pin!==pin) return res.json({error:'Wrong PIN'});
  if(Number(fromU[0].balance) < amount) return res.json({error:'Insufficient balance KES '+fromU[0].balance});

  let toU=await sql`SELECT * FROM users WHERE phone=${to_phone}`;
  if(!toU[0]){
    toU=await sql`INSERT INTO users (phone,name,balance) VALUES (${to_phone},${'User '+to_phone.slice(-4)},0) RETURNING *`;
  }
  await sql`UPDATE users SET balance=balance-${amount} WHERE phone=${from_phone}`;
  await sql`UPDATE users SET balance=balance+${amount} WHERE phone=${to_phone}`;
  const code='JPAY'+Date.now().toString().slice(-6);
  await sql`INSERT INTO transactions (from_user_id,to_user_id,phone,amount,type,mpesa_code) VALUES (${fromU[0].id},${toU[0].id},${from_phone},${amount},'send',${code})`;
  await sql`INSERT INTO transactions (from_user_id,to_user_id,phone,amount,type,mpesa_code) VALUES (${fromU[0].id},${toU[0].id},${to_phone},${amount},'receive',${code})`;
  res.json({success:true,amount,code});
 }catch(e){console.error(e);res.json({error:e.message})}
});

app.post('/deposit', async (req,res)=>{
 try{
  let {phone,amount}=req.body;
  phone=norm(phone); amount=Number(amount);
  if(amount<=0) return res.json({error:'Invalid amount'});
  const r=await sql`UPDATE users SET balance=balance+${amount} WHERE phone=${phone} RETURNING *`;
  if(!r[0]) return res.json({error:'User not found'});
  await sql`INSERT INTO transactions (to_user_id,phone,amount,type,mpesa_code) VALUES (${r[0].id},${phone},${amount},'deposit',${'DEP'+Date.now()})`;
  res.json({success:true,new_balance:r[0].balance});
 }catch(e){res.json({error:e.message})}
});

app.get('/api/health', (req,res)=>res.json({ok:true, time:new Date()}));

module.exports = app;
