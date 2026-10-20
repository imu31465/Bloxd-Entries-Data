# Bloxd.io ブロック/アイテム データ

ソース: bloxd.io メインバンドル (/static/js/3ymzdd.main.fae4743f.js)
抽出日: 2026-10-20T09:48:33.368Z

ゲーム本体と同じJavaScriptエンジン(V8)でバンドル内のレジストリ構築コードを実行して抽出しています。
そのため ID・プロパティは実ゲームと一致します(バンドル内ハードコードのID対応表と照合済み)。

## 更新方法

`node update.js` を実行すると、bloxd.io の最新バンドルを確認してこのフォルダ内のデータを更新します。

- `--force` : バンドルが前回と同じでも強制再抽出
- `--skip-fetch` : ダウンロード済みバンドルで再抽出 (ネットワーク不要)

バンドルはOSの一時フォルダにキャッシュされ、前回と同一なら更新はスキップされます。

## 構成

- update.js  : このフォルダを更新するスクリプト (依存ゼロ / Node >= 18)
- CHANGES.md : 直近の更新で生じた差分 (追加 / 削除 / ID変更)
- entries.json : 全エントリ(block+item)の id↔name 対応表 [{id, name}] (id順, 0〜N連番)
- entries/     : 個別JSON (ファイル名が5桁ゼロ埋めIDで始まるので名前順=ID順, kindでblock/itemを区別)

状態バリアント(向き・開閉・成長・チャージ等)も同じフォルダにまとまっています。
ファイル名は `00165_Furnace.meta.rot2.json` の形 (元の名前の `|` を `.` に置換)。
中身の `meta` フィールド (rootName / rootId / metaStr) が元エントリを参照します。

## ID体系

- 0 = Air (特別値)。1 = Unloaded(未ロードチャンク)。
- ブロック: 0〜7861 / アイテム: 7862〜9247
- ブロックとアイテムは連続した同一ID空間を共有 (アイテムは最大ブロックID+1から開始)

## 主なフィールド (全エントリ共通)

| フィールド | 意味 |
|---|---|
| id / name / kind | 数値ID / 正規名 (API用) / block または item |
| displayName | 表示名。key=翻訳キー, text=英語表示名 (解決できない場合は unresolved) |
| description | 説明文 (同上) |
| meta | 状態バリアント情報 {rootName, rootId, metaStr, rot, open, ...}。null キーは除去し、基本エントリでは省略 |
| rootMetaDesc | バリアントの完全名 (例 "Loot Chest|meta|rot4") |
| stackable | スタック可否 |

## 主なフィールド (ブロック系)

| フィールド | 意味 |
|---|---|
| ttb | Time To Break (破壊にかかる時間 ms) |
| harvestType | granule(粒)/wood(木)/rock(岩)/cuttable(刈取) などの破壊種別 |
| harvestLevel | 採掘に必要なツールレベル |
| drops | 破壊時ドロップ (未指定=自分自身, null=ドロップなし) |
| specialToolDrop | {tool, drops} 特定ツールでの特殊ドロップ |
| specialToolBonusDrops | {tool: [{bonusDrop, probabilityOfDrop}]} ボーナスドロップ |
| textureInfo | テクスチャ名。配列=面ごと。RGBA数値配列=単色 (例 Water) |
| texturePerSide | 6面へのテクスチャ割当インデックス |
| atlasIdx | テクスチャアトラス上のインデックス (アニメーションは配列) |
| model | CentreCross / rotatable / SquareSided / CustomModel などの描画モデル |
| solid | 当たり判定の有無 |
| soundType | {break, place} 破壊/設置音 |
| damage | 触れたときのダメージ (サボテン等) |
| stoodOnSpeedMultiplier | 上に立ったときの移動速度倍率 |
| canBePlacedOver / attachedTop / slabFullBlock | 設置挙動フラグ |
| onMinedAura | 採掘時パーティクルの色 |
| kV | ドア/トラップドアの状態->メッシュマッピング |

## 主なフィールド (アイテム系)

| フィールド | 意味 |
|---|---|
| type | Gun / Tool / Chargeable などの分類 |
| weight | 所持重量 |
| damage / attackRange / secondaryDamage | 武器ダメージ / 射程 |
| harvests / multiplier / level | ツールの対象・速度倍率・レベル |
| armourReduction / knockbackReduction | 防具性能 |
| eatable / eatHealAmt / afterEatenItem | 食料性能 |
| chargeTime / chargeStages / chargeSound | チャージ動作 |
| fireRate / reloadTime / clipSize / inaccuracy* / kickback* / scopeType | 銃のステータス |
| fishingRodInfo / comboInfo / dashImpulse | 特殊動作パラメータ |
| heldItemGlb / textureInfo | 手持ち3Dモデル / テクスチャ |

## 注意

- displayName.text はバンドル埋め込みの英語テーブルで解決 (他言語はゲーム起動時に別途取得されるため未収録)
- atlasIdx はゲーム実行時にテクスチャパック構成により変わりうる補助情報
- meta は null キーを除去して出力 (base エントリは meta 自体を省略)
