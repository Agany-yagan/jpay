require('dotenv').config();
const express = require('express');
const { Pool } = require('pg');
const path = require('path');
const axios = require('axios');
const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const pool = process.env.DATABASE_URL
 ? new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } })
  : new Pool({
      host: process.env.PGHOST || 'localhost',
      database: process.env.PGDATABASE || 'jpay',
      user: process.env.PGUSER,
      password: process.env.PGPASSWORD || '',
      port: process.env.PGPORT || 5432
    });

const ADMIN_PHONE = '0711000000';
const MPESA = {
  key: process.env.CONSUMER_KEY,
  secret: process.env.CONSUMER_SECRET,
  shortcode: process.env.MPESA_SHORTCODE || '174379',
  passkey: process.env.MPESA_PASSKEY || 'bfb279f9aa9bdbcf158e97dd71a467cd2e0c893059b10f78e6b72ada1ed2c919',
  callback: process.env.CALLBACK_URL || 'https://example.com/callback'
};

async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      phone VARCHAR(15) UNIQUE NOT NULL,
      name VARCHAR(100) NOT NULL,
      pin VARCHAR(4) NOT NULL,
      balance BIGINT DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS transactions (
      id SERIAL PRIMARY KEY,
      from_user_id INT REFERENCES users(id),
      to_user_id INT REFERENCES users(id),
      amount BIGINT NOT NULL,
      type VARCHAR(20) NOT NULL,
      note TEXT,
      created_at TIMESTAMP DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS agents (
      id SERIAL PRIMARY KEY,
      till_number VARCHAR(10) UNIQUE NOT NULL,
      phone VARCHAR(15) REFERENCES users(phone),
      name VARCHAR(100) NOT NULL,
      commission_balance BIGINT DEFAULT 0,
      created_at TIMESTAMP DEFAULT NOW()
    );
  `);
  await pool.query(`INSERT INTO users(phone,name,pin,balance) VALUES($1,'Admin','0000',0) ON CONFLICT (phone) DO NOTHING`, [ADMIN_PHONE]);
  console.log('DB ready V5 Till + Sandbox');
}
initDb();

async function getMpesaToken() {
  const auth = Buffer.from(`${MPESA.key}:${MPESA.secret}`).toString('base64');
  const res = await axios.get('https://sandbox.safaricom.co.ke/oauth/v1/generate?grant_type=client_credentials', {
    headers: { Authorization: `Basic ${auth}` }
  });
  return res.data.access_token;
}

app.post('/api/register', async (req, res) => {
  const { phone, name, pin } = req.body;
  if(!phone ||!name ||!pin || String(pin).length!=4) return res.status(400).json({error:"4-digit PIN required"});
  try{
    const r = await pool.query('INSERT INTO users(phone,name,pin,balance) VALUES($1,$2,$3,0) RETURNING *', [phone.trim(), name.trim(), String(pin).trim()]);
    res.json({success:true, user:r.rows[0]});
  }catch(e){
    if(e.code==='23505') return res.status(400).json({error:"Phone exists"});
    res.status(500).json({error:e.message});
  }
});

app.post('/api/login', async (req,res)=>{
  const {phone,pin}=req.body;
  const r= await pool.query('SELECT * FROM users WHERE phone=$1 AND pin=$2', [phone, String(pin)]);
  if(r.rows.length==0) return res.status(401).json({error:"Wrong phone or PIN"});
  res.json({success:true, user:r.rows[0]});
});

app.get('/balance/:phone', async (req,res)=>{
  const r=await pool.query('SELECT name,phone,balance FROM users WHERE phone=$1', [req.params.phone]);
  if(r.rows.length==0) return res.status(404).json({error:"User not found"});
  res.json(r.rows[0]);
});

app.post('/deposit', async (req,res)=>{
  let {phone, amount}=req.body;
  amount=parseInt(amount);
  const r=await pool.query('UPDATE users SET balance=balance+$1 WHERE phone=$2 RETURNING *', [amount, phone]);
  if(r.rows.length==0) return res.status(404).json({error:"User not found"});
  await pool.query('INSERT INTO transactions(from_user_id,to_user_id,amount,type,note) VALUES(NULL,$1,$2,$3,$4)', [r.rows[0].id, amount, 'DEPOSIT', 'Manual deposit']);
  res.json({success:true, user:r.rows[0]});
});

app.post('/api/stk', async (req,res)=>{
  let {phone, amount} = req.body;
  if(!phone ||!amount) return res.status(400).json({error:"phone and amount required"});
  phone = String(phone).replace(/^0/, '254');
  if(!phone.startsWith('254')) phone = '254'+phone.slice(-9);
  try{
    const token = await getMpesaToken();
    const timestamp = new Date().toISOString().replace(/[^0-9]/g,'').slice(0,14);
    const password = Buffer.from(`${MPESA.shortcode}${MPESA.passkey}${timestamp}`).toString('base64');
    const payload = {
      BusinessShortCode: MPESA.shortcode,
      Password: password,
      Timestamp: timestamp,
      TransactionType: "CustomerPayBillOnline",
      Amount: parseInt(amount),
      PartyA: phone,
      PartyB: MPESA.shortcode,
      PhoneNumber: phone,
      CallBackURL: MPESA.callback,
      AccountReference: "JPayV5",
      TransactionDesc: "JPay Deposit"
    };
    const mpesaRes = await axios.post('https://sandbox.safaricom.co.ke/mpesa/stkpush/v1/processrequest', payload, {
      headers: { Authorization: `Bearer ${token}` }
    });
    console.log('STK Push sent:', mpesaRes.data);
    res.json({success:true, message:"STK sent to "+phone, data: mpesaRes.data});
  }catch(e){
    console.error('STK Error:', e.response?.data || e.message);
    res.status(500).json({error: e.response?.data || e.message});
  }
});

app.post('/callback', async (req,res)=>{
  console.log('CALLBACK:', JSON.stringify(req.body, null,2));
  try{
    const stk = req.body?.Body?.stkCallback;
    if(stk && stk.ResultCode===0){
      const meta = stk.CallbackMetadata?.Item;
      const amount = meta?.find(i=>i.Name==='Amount')?.Value;
      const phone = meta?.find(i=>i.Name==='PhoneNumber')?.Value;
      const phoneStr = String(phone);
      const normalized = '0'+phoneStr.slice(-9);
      if(amount){
        await pool.query('UPDATE users SET balance=balance+$1 WHERE phone IN ($2,$3) RETURNING *', [amount, phoneStr, normalized]);
        console.log(`Credited ${amount} to ${phoneStr}`);
      }
    }
  }catch(e){ console.error('Callback DB error', e.message); }
  res.json({ResultCode:0, ResultDesc:"Accepted"});
});

app.get('/', (req,res)=> res.sendFile(path.join(__dirname,'public','index.html')));

const PORT = process.env.PORT || 3000;
app.listen(PORT, ()=> console.log(`JPay V5 running on http://localhost:${PORT}`));
