import fs from 'node:fs'

let db = fs.readFileSync('electron/db.js', 'utf8')

// 1. Add migrateFishingAttrs function before migrateCreditPack
const oldCreditComment = `// ---------- 赊账包迁移`
const newFishingMigrate = `// ---------- 渔具专用属性迁移（v2.0）：只增不改，老数据新列为 NULL ----------
function migrateFishingAttrs(db) {
  const addCol = (col, ddl) => {
    const cols = db.prepare('PRAGMA table_info(products)').all().map((c) => c.name)
    if (!cols.includes(col)) db.exec(\`ALTER TABLE products ADD COLUMN \${ddl}\`)
  }
  addCol('rod_length', 'rod_length TEXT')
  addCol('line_number', 'line_number TEXT')
  addCol('hook_size', 'hook_size TEXT')
  addCol('color', 'color TEXT')
  addCol('material', 'material TEXT')
  addCol('rod_action', 'rod_action TEXT')
  addCol('power_rating', 'power_rating TEXT')
  addCol('expiry_date', 'expiry_date TEXT')
}

// ---------- 赊账包迁移`

if (db.includes(oldCreditComment)) {
  db = db.replace(oldCreditComment, newFishingMigrate)
  console.log('migrateFishingAttrs added')
} else {
  console.log('credit comment NOT FOUND')
  const lines = db.split('\n')
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].includes('赊账包迁移')) {
      console.log(`Found at line ${i + 1}:`, lines[i].trim())
    }
  }
}

// 2. Add migrateFishingAttrs call in openDatabase after migrateCreditPack
const oldDbCall = '  migrateCreditPack(db)\n  const row = db.prepare'
const newDbCall = '  migrateCreditPack(db)\n  migrateFishingAttrs(db)\n  const row = db.prepare'
if (db.includes(oldDbCall)) {
  db = db.replace(oldDbCall, newDbCall)
  console.log('migrateFishingAttrs call added')
} else {
  console.log('db open call NOT FOUND')
}

// 3. Add new indexes
const oldEnd = `CREATE INDEX IF NOT EXISTS idx_stock_take_items_take ON stock_take_items(stock_take_id);

`

if (db.includes(oldEnd)) {
  db = db.replace(oldEnd, oldEnd + `CREATE INDEX IF NOT EXISTS idx_po_status ON purchase_orders(status);
CREATE INDEX IF NOT EXISTS idx_po_items_po ON purchase_order_items(po_id);
CREATE INDEX IF NOT EXISTS idx_price_tiers_product ON price_tiers(product_id);

`)
  console.log('New indexes added')
}

fs.writeFileSync('electron/db.js', db)
console.log('Done')
