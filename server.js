require('dotenv').config();
const express = require('express');
const { Pool } = require('pg');
const path = require('path');
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
const FEE = 5;
const AGENT_COMMISSION = 3; // agent gets 3, admin gets 2 from the 5

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
  console.log('DB ready V5 Till');
}
initDb();

// --- EXISTING ROUTES ---
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
app.post('/register', (req,res)=>{ req.url='/api/register'; app._router.handle(req,res); });
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
  const amt=parseInt(String(amount).replace(/\D/g,''),10);
  if(isNaN(amt)||amt<=0) return res.status(400).json({error:"Invalid amount"});
  const r=await pool.query('UPDATE users SET balance=balance+$1 WHERE phone=$2 RETURNING balance', [amt, phone]);
  if(r.rows.length==0) return res.status(404).json({error:"User not found"});
  res.json({success:true, new_balance:r.rows[0].balance});
});
app.post('/transfer', async (req, res) => {
  const { from_phone, to_phone, amount, pin } = req.body;
  try {
    const sendAmount = parseInt(String(amount).replace(/\D/g,''),10);
    if(!from_phone ||!to_phone || isNaN(sendAmount) || sendAmount<=0) return res.status(400).json({error:'Invalid amount'});
    if(sendAmount>1000000) return res.status(400).json({error:'Max 1M'});
    if(from_phone===to_phone) return res.status(400).json({error:'Cannot send to self'});
    if(to_phone===ADMIN_PHONE) return res.status(400).json({error:'Invalid receiver'});
    const fromQ = await pool.query('SELECT * FROM users WHERE phone=$1', [from_phone]);
    if(fromQ.rows.length===0) return res.status(404).json({error:'Sender not found'});
    const fromUser = fromQ.rows[0];
    if(String(fromUser.pin)!==String(pin)) return res.status(401).json({error:'Wrong PIN'});
    const toQ = await pool.query('SELECT * FROM users WHERE phone=$1', [to_phone]);
    if(toQ.rows.length===0) return res.status(404).json({error:'Receiver not found'});
    const fromBal = parseInt(fromUser.balance,10);
    const totalCharge = sendAmount + FEE;
    if(fromBal < totalCharge) return res.status(400).json({error:`Insufficient: need ${totalCharge}, have ${fromBal}`});
    await pool.query('BEGIN');
    await pool.query('UPDATE users SET balance=balance-$1 WHERE phone=$2', [totalCharge, from_phone]);
    await pool.query('UPDATE users SET balance=balance+$1 WHERE phone=$2', [sendAmount, to_phone]);
    await pool.query('UPDATE users SET balance=balance+$1 WHERE phone=$2', [FEE, ADMIN_PHONE]);
    await pool.query('INSERT INTO transactions (from_user_id,to_user_id,amount,type,note) VALUES ($1,$2,$3,$4,$5)', [fromUser.id, toQ.rows[0].id, sendAmount, 'TRANSFER', `To ${to_phone}`]);
    await pool.query('COMMIT');
    res.json({success:true, amount:sendAmount, fee:FEE, charged:totalCharge});
  } catch(e){
    await pool.query('ROLLBACK');
    res.status(500).json({error:e.message});
  }
});
app.get('/api/user/:phone', async (req, res) => {
  const pin = req.query.pin;
  const userRes = await pool.query('SELECT * FROM users WHERE phone=$1 AND pin=$2', [req.params.phone, pin]);
  if (userRes.rows.length===0) return res.status(404).json({error:"User not found or wrong PIN"});
  const user = userRes.rows[0];
  const txRes = await pool.query(`SELECT t.* FROM transactions t WHERE t.from_user_id=$1 OR t.to_user_id=$1 ORDER BY t.created_at DESC LIMIT 20`, [user.id]);
  res.json({user, transactions: txRes.rows});
});
app.get('/admin/users', async (req, res) => {
  const result = await pool.query("SELECT id, phone, name, balance FROM users WHERE phone!=$1 ORDER BY id DESC", [ADMIN_PHONE]);
  const totalRes = await pool.query('SELECT SUM(balance) as total FROM users WHERE phone!=$1', [ADMIN_PHONE]);
  const profitRes = await pool.query("SELECT balance FROM users WHERE phone=$1", [ADMIN_PHONE]);
  const agentsRes = await pool.query('SELECT * FROM agents ORDER BY id DESC');
  res.json({users: result.rows, total_money: parseInt(totalRes.rows[0].total||0,10), total_profit: parseInt(profitRes.rows[0]?.balance||0,10), agents: agentsRes.rows});
});

// --- NEW TILL / AGENT ROUTES ---

// Register Agent Till
app.post('/api/agent/register', async (req,res)=>{
  const {phone, till_number, name} = req.body;
  if(!phone||!till_number||String(till_number).length<5) return res.status(400).json({error:"Phone and 5-6 digit Till required"});
  try{
    const userQ = await pool.query('SELECT * FROM users WHERE phone=$1', [phone]);
    if(userQ.rows.length==0) return res.status(404).json({error:"User phone must exist first - register user"});
    const r = await pool.query('INSERT INTO agents(till_number,phone,name) VALUES($1,$2,$3) RETURNING *', [String(till_number).trim(), phone, name||userQ.rows[0].name]);
    res.json({success:true, agent:r.rows[0]});
  }catch(e){
    if(e.code==='23505') return res.status(400).json({error:"Till number already exists"});
    res.status(500).json({error:e.message});
  }
});

// Agent Deposit: Customer gives cash to agent, agent credits customer
app.post('/till/deposit', async (req,res)=>{
  const {till_number, customer_phone, amount, agent_pin} = req.body;
  const amt = parseInt(String(amount).replace(/\D/g,''),10);
  if(isNaN(amt)||amt<=0) return res.status(400).json({error:"Invalid amount"});
  try{
    const agentQ = await pool.query('SELECT a.*, u.pin, u.id as user_id, u.balance FROM agents a JOIN users u ON a.phone=u.phone WHERE a.till_number=$1', [String(till_number)]);
    if(agentQ.rows.length==0) return res.status(404).json({error:"Till not found"});
    const agent = agentQ.rows[0];
    if(String(agent.pin)!==String(agent_pin)) return res.status(401).json({error:"Wrong Agent PIN"});
    const custQ = await pool.query('SELECT * FROM users WHERE phone=$1', [customer_phone]);
    if(custQ.rows.length==0) return res.status(404).json({error:"Customer not found"});
    // Agent must have enough float to deposit? For now allow even if 0 (agent receives cash physically)
    await pool.query('BEGIN');
    await pool.query('UPDATE users SET balance=balance+$1 WHERE phone=$2', [amt, customer_phone]);
    await pool.query('UPDATE agents SET commission_balance=commission_balance+$1 WHERE till_number=$2', [AGENT_COMMISSION, String(till_number)]);
    await pool.query('UPDATE users SET balance=balance+$1 WHERE phone=$2', [FEE-AGENT_COMMISSION, ADMIN_PHONE]);
    await pool.query('INSERT INTO transactions(from_user_id,to_user_id,amount,type,note) VALUES($1,$2,$3,$4,$5)', [agent.user_id, custQ.rows[0].id, amt, 'TILL_DEPOSIT', `Deposit via Till ${till_number} to ${customer_phone}`]);
    await pool.query('COMMIT');
    res.json({success:true, message:`Deposited ${amt} to ${customer_phone}`, amount:amt, commission:AGENT_COMMISSION});
  }catch(e){ await pool.query('ROLLBACK'); res.status(500).json({error:e.message}) }
});

// Agent Withdraw: Customer wants cash, sends to agent till
app.post('/till/withdraw', async (req,res)=>{
  const {till_number, customer_phone, amount, customer_pin} = req.body;
  const amt = parseInt(String(amount).replace(/\D/g,''),10);
  if(isNaN(amt)||amt<=0) return res.status(400).json({error:"Invalid amount"});
  try{
    const agentQ = await pool.query('SELECT a.*, u.id as user_id FROM agents a JOIN users u ON a.phone=u.phone WHERE a.till_number=$1', [String(till_number)]);
    if(agentQ.rows.length==0) return res.status(404).json({error:"Till not found"});
    const custQ = await pool.query('SELECT * FROM users WHERE phone=$1', [customer_phone]);
    if(custQ.rows.length==0) return res.status(404).json({error:"Customer not found"});
    if(String(custQ.rows[0].pin)!==String(customer_pin)) return res.status(401).json({error:"Wrong Customer PIN"});
    const total = amt + FEE;
    if(parseInt(custQ.rows[0].balance,10) < total) return res.status(400).json({error:`Insufficient: need ${total}, have ${custQ.rows[0].balance}`});
    const agentUserQ = await pool.query('SELECT * FROM users WHERE phone=$1', [agentQ.rows[0].phone]);
    await pool.query('BEGIN');
    await pool.query('UPDATE users SET balance=balance-$1 WHERE phone=$2', [total, customer_phone]);
    await pool.query('UPDATE users SET balance=balance+$1 WHERE phone=$2', [amt, agentQ.rows[0].phone]);
    await pool.query('UPDATE agents SET commission_balance=commission_balance+$1 WHERE till_number=$2', [AGENT_COMMISSION, String(till_number)]);
    await pool.query('UPDATE users SET balance=balance+$1 WHERE phone=$2', [FEE-AGENT_COMMISSION, ADMIN_PHONE]);
    await pool.query('INSERT INTO transactions(from_user_id,to_user_id,amount,type,note) VALUES($1,$2,$3,$4,$5)', [custQ.rows[0].id, agentUserQ.rows[0].id, amt, 'TILL_WITHDRAW', `Withdraw via Till ${till_number} by ${customer_phone}`]);
    await pool.query('COMMIT');
    res.json({success:true, message:`Withdraw ${amt} via till ${till_number} - give cash to customer`, amount:amt, fee:FEE, commission:AGENT_COMMISSION});
  }catch(e){ await pool.query('ROLLBACK'); res.status(500).json({error:e.message}) }
});

// Get agent info
app.get('/till/:till_number', async (req,res)=>{
  const r = await pool.query('SELECT a.*, u.balance as float_balance FROM agents a JOIN users u ON a.phone=u.phone WHERE a.till_number=$1', [req.params.till_number]);
  if(r.rows.length==0) return res.status(404).json({error:"Till not found"});
  res.json(r.rows[0]);
});
const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', ()=> console.log(`JPay V5 live on ${PORT}`));
