const express = require('express');
const { Pool } = require('pg');
const axios = require('axios');
const cors = require('cors');
require('dotenv').config();

const app = express();
app.use(express.json());
app.use(cors());

const pool = process.env.DATABASE_URL
? new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } })
  : new Pool({
      host: process.env.PGHOST,
      user: process.env.PGUSER,
      password: process.env.PGPASSWORD,
      database: process.env.PGDATABASE,
      port: process.env.PGPORT || 5432,
      ssl: process.env.PGSSLMODE === 'require'? { rejectUnauthorized: false } : false
    });

pool.query(`
  CREATE TABLE IF NOT EXISTS users (
    id SERIAL PRIMARY KEY,
    phone VARCHAR(20) UNIQUE NOT NULL,
    name VARCHAR(100),
    pin VARCHAR(100),
    balance DECIMAL DEFAULT 0,
    pin_hash TEXT,
    created_at TIMESTAMP DEFAULT NOW()
  );
  CREATE TABLE IF NOT EXISTS transactions (
    id SERIAL PRIMARY KEY,
    phone VARCHAR(20),
    amount DECIMAL,
    type VARCHAR(20),
    mpesa_code VARCHAR(50),
    created_at TIMESTAMP DEFAULT NOW()
  );
`).then(()=>console.log("DB ready")).catch(e=>console.error(e));

async function getToken(){
  const auth = Buffer.from(`${process.env.CONSUMER_KEY}:${process.env.CONSUMER_SECRET}`).toString('base64');
  const res = await axios.get('https://sandbox.safaricom.co.ke/oauth/v1/generate?grant_type=client_credentials',{headers:{Authorization:`Basic ${auth}`}});
  return res.data.access_token;
}

app.post('/api/register', async (req,res)=>{
  let {phone,name,pin}=req.body;
  phone=phone.replace(/^0/,'254').replace(/^\+/,'');
  if(phone.startsWith('07')) phone='254'+phone.slice(1);
  try{
    const r=await pool.query('INSERT INTO users (phone,name,pin,balance) VALUES ($1,$2,$3,1000) ON CONFLICT (phone) DO UPDATE SET name=$2,pin=$3 RETURNING *',[phone,name,pin]);
    res.json({success:true,user:r.rows[0]});
  }catch(e){res.status(500).json({error:e.message});}
});

app.post('/api/stk', async (req,res)=>{
  let {phone,amount}=req.body;
  phone=phone.replace(/^0/,'254').replace(/^\+/,'');
  if(phone.startsWith('07')) phone='254'+phone.slice(1);
  try{
    const token=await getToken();
    const timestamp=new Date().toISOString().replace(/[-T:.Z]/g,'').slice(0,14);
    const password=Buffer.from(`${process.env.MPESA_SHORTCODE}${process.env.MPESA_PASSKEY}${timestamp}`).toString('base64');
    const resp=await axios.post('https://sandbox.safaricom.co.ke/mpesa/stkpush/v1/processrequest',{
      BusinessShortCode:process.env.MPESA_SHORTCODE,
      Password:password,
      Timestamp:timestamp,
      TransactionType:'CustomerPayBillOnline',
      Amount:amount,
      PartyA:phone,
      PartyB:process.env.MPESA_SHORTCODE,
      PhoneNumber:phone,
      CallBackURL:process.env.CALLBACK_URL,
      AccountReference:'JPay',
      TransactionDesc:'Deposit'
    },{headers:{Authorization:`Bearer ${token}`}});
    res.json({success:true,message:`STK sent to ${phone}`,data:resp.data});
  }catch(e){console.error(e.response?.data||e.message); res.status(500).json({error:e.response?.data||e.message});}
});

app.post('/callback', async (req,res)=>{
  console.log('CALLBACK:',JSON.stringify(req.body));
  try{
    const cb=req.body.Body?.stkCallback;
    if(cb?.ResultCode===0){
      const meta=cb.CallbackMetadata?.Item;
      const amount=meta.find(i=>i.Name==='Amount')?.Value;
      const phone=meta.find(i=>i.Name==='PhoneNumber')?.Value?.toString();
      const code=meta.find(i=>i.Name==='MpesaReceiptNumber')?.Value;
      if(phone&&amount){
        await pool.query('UPDATE users SET balance=balance+$1 WHERE phone=$2',[amount,phone]);
        await pool.query('INSERT INTO transactions (phone,amount,type,mpesa_code) VALUES ($1,$2,$3,$4)',[phone,amount,'deposit',code]);
        console.log(`Credited ${amount} to ${phone}`);
      }
    }
  }catch(e){console.error(e);}
  res.json({ResultCode:0,ResultDesc:'Accepted'});
});

app.post("/api/send", async (req, res) => {
  try {
    let { fromPhone, toPhone, amount, pin } = req.body;
    console.log('SEND REQ:', req.body);
    amount = Number(amount);
    if(!fromPhone ||!toPhone ||!amount) return res.status(400).json({error: "missing fields"});

    fromPhone = fromPhone.replace(/^0/,'254').replace(/^\+/,'');
    if(fromPhone.startsWith('07')) fromPhone='254'+fromPhone.slice(1);
    toPhone = toPhone.replace(/^0/,'254').replace(/^\+/,'');
    if(toPhone.startsWith('07')) toPhone='254'+toPhone.slice(1);

    // Auto create users for testing with 1000 balance
    await pool.query("INSERT INTO users (phone,balance) VALUES ($1,1000) ON CONFLICT (phone) DO NOTHING", [fromPhone]);
    await pool.query("INSERT INTO users (phone,balance) VALUES ($1,0) ON CONFLICT (phone) DO NOTHING", [toPhone]);

    const senderRes = await pool.query("SELECT balance FROM users WHERE phone=$1", [fromPhone]);
    const bal = Number(senderRes.rows[0]?.balance || 0);
    if(bal < amount) return res.status(400).json({error: `Insufficient balance: ${bal}`});

    await pool.query("UPDATE users SET balance = balance - $1 WHERE phone=$2", [amount, fromPhone]);
    await pool.query("UPDATE users SET balance = balance + $1 WHERE phone=$2", [amount, toPhone]);

    await pool.query("INSERT INTO transactions (phone, amount, type, mpesa_code) VALUES ($1,$2,'send',$3)", [fromPhone, -amount, 'jpay-'+Date.now()]);
    await pool.query("INSERT INTO transactions (phone, amount, type, mpesa_code) VALUES ($1,$2,'receive',$3)", [toPhone, amount, 'jpay-'+Date.now()]);

    res.json({success: true, message: `Sent ${amount} to ${toPhone}`, from: fromPhone, to: toPhone});
  } catch(e){
    console.error("SEND ERROR:", e);
    res.status(500).json({error: e.message || String(e)});
  }
});

app.post('/deposit', async (req,res)=>{
  let {phone,amount}=req.body;
  phone=phone.replace(/^0/,'254').replace(/^\+/,'');
  if(phone.startsWith('07')) phone='254'+phone.slice(1);
  await pool.query('INSERT INTO users (phone,balance) VALUES ($1,$2) ON CONFLICT (phone) DO UPDATE SET balance=users.balance+$2',[phone,amount]);
  res.json({success:true});
});

app.get('/balance/:phone', async (req,res)=>{
  let phone=req.params.phone.replace(/^0/,'254').replace(/^\+/,'');
  if(phone.startsWith('07')) phone='254'+phone.slice(1);
  const r=await pool.query('SELECT phone,name,balance FROM users WHERE phone=$1',[phone]);
  if(!r.rows[0]) return res.status(404).json({error:'User not found'});
  res.json(r.rows[0]);
});

app.get('/',(req,res)=>res.send('JPay V7 Send Fixed - Auto create users'));

const PORT=process.env.PORT||10000;
app.listen(PORT,()=>console.log(`JPay live on ${PORT}`));
