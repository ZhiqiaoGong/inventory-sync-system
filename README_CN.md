# 分层式跨平台库存同步系统（Shopify + Etsy + 内部库存表）

这是一个适合小团队 / 小公司逐步落地的库存系统原型。

它的核心思想不是“一刀切把所有商品都自动同步”，而是：

- **Tier 1：标准 SKU** → 自动同步
- **Tier 2：可跟踪但不自动同步** → 只做监控/内部扣减
- **Tier 3：复杂 SKU** → 保留人工流程

---

## 一、系统做了什么

### 1. 新建一张标准化内部库存表
这张表按“件（unit）”管理库存，而不是原先 Excel 那种混合了包库存和工作区库存的方式。

### 2. 建立 SKU mapping
把 Shopify / Etsy / 内部 SKU 统一映射到 `internal_sku`。

### 3. 从平台拉订单
- Shopify：拉已支付订单
- Etsy：拉 receipt / transaction

### 4. 订单驱动库存更新
- Tier 1：更新中央库存，并尝试回写 Shopify / Etsy
- Tier 2：更新中央库存或内部趋势，但不回写平台
- Tier 3：保留人工流程

### 5. 提供低库存视图
通过 `/inventory/low-stock` 查看低库存商品。

---

## 二、目录结构

```text
inventory-sync-system/
├─ package.json
├─ .env.example
├─ sample_inventory.csv
├─ README_CN.md
├─ src/
│  ├─ db.js
│  ├─ platforms.js
│  ├─ services.js
│  └─ server.js
└─ scripts/
   ├─ initDb.js
   ├─ importInventoryCsv.js
   └─ syncOrdersOnce.js
```

---

## 三、如何运行

### 1. 安装依赖

```bash
npm install
```

### 2. 复制环境变量

```bash
cp .env.example .env
```

然后把 `.env` 里的 Shopify / Etsy 配置改成你自己的。

### 3. 初始化数据库

```bash
npm run init-db
```

### 4. 导入示例库存 CSV

```bash
npm run import-csv -- ./sample_inventory.csv
```

### 5. 启动服务

```bash
npm start
```

### 6. 常用接口

- 健康检查：`GET /health`
- 查看库存：`GET /inventory`
- 查看低库存：`GET /inventory/low-stock`
- 同步 Shopify：`POST /sync/shopify`
- 同步 Etsy：`POST /sync/etsy`
- 同步全部：`POST /sync/all`

---

## 四、CSV 字段说明

示例表头：

```csv
internal_sku,product_name,tier,sync_enabled,monitoring_enabled,available_units,low_stock_threshold,units_per_pack,notes,shopify_sku,shopify_variant_id,shopify_inventory_item_id,shopify_location_id,etsy_sku,etsy_listing_id,etsy_offering_id
```

### 核心字段

- `internal_sku`：系统内部统一 SKU
- `tier`：tier1 / tier2 / tier3
- `sync_enabled`：是否允许平台回写
- `available_units`：件级库存
- `low_stock_threshold`：低库存告警阈值

### 平台 mapping 字段

- `shopify_sku`
- `shopify_variant_id`
- `shopify_inventory_item_id`
- `shopify_location_id`
- `etsy_sku`
- `etsy_listing_id`
- `etsy_offering_id`

---

## 五、关于 Etsy 推送说明

这个项目里已经预留了 Etsy 推送接口，但 Etsy listing inventory 的实际 payload 结构会依你的店铺 listing 变体结构而变。

也就是说：

- **订单拉取框架已经具备**
- **同步日志和调用入口已经具备**
- **真正上线时你还需要按你店铺某个标准 listing 的返回结构，把 `productsPayload` 补完整**

这是正常的，因为 Etsy inventory schema 相比 Shopify 更依赖具体 listing 结构。

---

## 六、这个系统适合怎么讲

你可以这样描述它：

> I designed and implemented a tiered cross-platform inventory system by first introducing a normalized unit-level inventory table as a consistent internal representation, then enabling automatic synchronization for standardized SKUs while keeping more complex SKUs in tracked or manual workflows as part of a phased rollout.

---

## 七、当前系统边界

这个版本是一个**可运行的原型 / MVP**，已经能：

- 维护标准化内部库存表
- 支持 SKU 分层
- 拉 Shopify / Etsy 订单
- 对 Tier 1 SKU 自动扣减并尝试回写平台
- 对 Tier 2 / Tier 3 SKU 保留更稳妥的处理方式

但它还不是“完整 ERP”，目前没有包含：

- 自动 OAuth 刷新
- 复杂 bundle/kit 拆分
- 并发锁
- 完整定时任务调度器
- 更复杂的 Etsy inventory payload 自动构建

这些都可以作为下一步演进方向。
