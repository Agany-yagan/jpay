const express = require('express');
const { Pool } = require('pg');
const cors = require('cors');
require('dotenv').config();

const app = express();
app.use(express.json());
app.use(cors());

console.log("ENV CHECK DATABASE_URL:",!!process.env.DATABASE_URL);

const pool = process.env.DATABASE_URL
? new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } })
  : new Pool({ host: process.env.PGHOST, user: process.env.PGUSER, password: process.env.PGPASSWORD, database: process.env.PGDATABASE, port: process.env.PGPORT||5432, ssl: { rejectUnauthorized: false } });

pool.on('error', e=>console.error('POOL ERROR', e));

pool.query('SELECT NOW()').then(()=>console.log("DB connected")).catch(e=>console.error("DB FAIL", e));

pool.query(`
  CREATE TABLE IF NOT EXISTS users (id SERIAL PRIMARY KEY, phone VARCHAR(20) UNIQUE NOT NULL, name VARCHAR(100), pin VARCHAR(100), balance DECIMAL DEFAULT 0, created_at TIMESTAMP DEFAULT NOW());
  CREATE TABLE IF NOT EXISTS transactions (id SERIAL PRIMARY KEY, phone VARCHAR(20), amount DECIMAL, type VARCHAR(20), mpesa_code VARCHAR(50), created_at TIMESTAMP DEFAULT NOW());
`).then(()=>console.log("DB ready")).catch(e=>console.error(e));

app.post("/api/send", async (req, res) => {
  try {
    let { fromPhone, toPhone, amount } = req.body;
    console.log('SEND REQ:', req.body);
    amount = Number(amount);
    fromPhone = fromPhone?.toString().replace(/^0/,'254').replace(/^\+/,'');
    if(fromPhone?.startsWith('07')) fromPhone='254'+fromPhone.slice(1);
    toPhone = toPhone?.toString().replace(/^0/,'254').replace(/^\+/,'');
    if(toPhone?.startsWith('07')) toPhone='254'+toPhone.slice(1);

    console.log('Trying DB insert...');
    await pool.query("INSERT INTO users (phone,balance) VALUES ($1,1000) ON CONFLICT (phone) DO NOTHING", [fromPhone]);
    await pool.query("INSERT INTO users (phone,balance) VALUES ($1,0) ON CONFLICT (phone) DO NOTHING", [toPhone]);
    console.log('Users ensured');

    const senderRes = await pool.query("SELECT balance FROM users WHERE phone=$1", [fromPhone]);
    console.log('Balance row', senderRes.rows[0]);

    await pool.query("UPDATE users SET balance = balance - $1 WHERE phone=$2", [amount, fromPhone]);
    await pool.query("UPDATE users SET balance = balance + $1 WHERE phone=$2", [amount, toPhone]);
    await pool.query("INSERT INTO transactions (phone, amount, type, mpesa_code) VALUES ($1,$2,'send',$3)", [fromPhone, -amount, 'jpay-'+Date.now()]);
    await pool.query("INSERT INTO transactions (phone, amount, type, mpesa_code) VALUES ($1,$2,'receive',$3)", [toPhone, amount, 'jpay-'+Date.now()]);

    res.json({success: true, message: `Sent ${amount} to ${toPhone}`});
  } catch(e){
    console.error("SEND ERROR FULL:", e);
    res.status(500).json({error: e.message + ' | ' + (e.errors?.map(er=>er.message).join(',')), stack: e.stack?.slice(0,500)});
  }
});

app.get('/',(req,res)=>res.send('JPay V8 debug'));
app.get('/balance/:phone', async (req,res)=>{
  try{
    let phone=req.params.phone.replace(/^0/,'254').replace(/^\+/,'');
    if(phone.startsWith('07')) phone='254'+phone.slice(1);
    const r=await pool.query('SELECT * FROM users WHERE phone=$1',[phone]);
    if(!r.rows[0]) return res.status(404).json({error:'User not found'});
    res.json(r.rows[0]);
  }catch(e){res.json({error:e.message});}
});
app.post('/api/register', async (req,res)=>{
  try{
    let {phone,name,pin}=req.body; phone=phone.replace(/^0/,'254').replace(/^\+/,''); if(phone.startsWith('07')) phone='254'+phone.slice(1);
    const r=await pool.query('INSERT INTO users (phone,name,pin,balance) VALUES ($1,$2,$3,1000) ON CONFLICT (phone) DO UPDATE SET name=$2,pin=$3 RETURNING *',[phone,name,pin]);
    res.json({success:true,user:r.rows[0]});
  }catch(e){res.json({error:e.message});}
});

const PORT=process.env.PORT||10000;
app.listen(PORT,()=>console.log(`JPay live on ${PORT}`));
