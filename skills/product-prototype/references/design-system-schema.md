# DesignSpecV1

当前请求里的完整 `designSpec` 已经由用户确认并锁定。生成时必须遵守它；保存时省略 `design_spec`，可信 Host 会自动绑定锁定版本。旧客户端若仍传该字段，工具会校验完整指纹，任何改动都会拒绝。若用户要求改变视觉规范，不能在原型保存时绕过确认：尚无历史版本时，让用户在规范页点击“重新调整规范”；已有历史版本时，让用户点击“查看完整规范”后选择“基于同一参考创建新方案”。新方案会重新确认规范，旧原型与历史版本保持不变。只有参考网页本身已变化或证据校验失败时，才需要重新采集。

```json
{
  "v": 1,
  "id": "design-main",
  "name": "参考网页设计规范",
  "basedOnEvidenceIds": ["ref-authorized"],
  "summary": "一句可执行的视觉总结",
  "colors": [
    { "name": "主要操作色", "value": "#2563eb", "usage": "按钮、链接和选中状态" },
    { "name": "按钮文字", "value": "#ffffff", "usage": "主要操作上的文字和图标" }
  ],
  "typography": {
    "fontFamily": "system-ui",
    "headingWeight": 700,
    "bodySize": 14,
    "headingSize": 28,
    "captionSize": 12,
    "bodyLineHeight": 1.5,
    "headingLineHeight": 1.15,
    "letterSpacing": 0
  },
  "spacing": {
    "base": 8,
    "cardRadius": 12,
    "scale": [4, 8, 12, 16, 24, 32],
    "sectionGap": 32,
    "contentWidth": 1120
  },
  "surfaces": {
    "page": "#f8fafc",
    "surface": "#ffffff",
    "elevated": "#ffffff",
    "text": "#172033",
    "textMuted": "#64748b",
    "border": "#e2e8f0"
  },
  "borders": { "width": 1, "style": "solid", "radiusScale": [4, 8, 12] },
  "effects": {
    "shadows": ["0 8px 24px rgba(15, 23, 42, 0.12)"],
    "gradients": [],
    "opacities": [0.6, 0.8]
  },
  "controls": { "height": 40, "inputHeight": 40, "radius": 8 },
  "motion": { "durations": ["160ms"], "easings": ["ease-out"] },
  "focus": { "width": 2, "style": "solid", "color": "#2563eb", "offset": 2 },
  "responsive": { "breakpoints": [640, 768, 1024], "layoutPatterns": ["flex-row", "grid"] },
  "principles": ["保持清晰层级", "组件状态可辨认"]
}
```

约束：

- 颜色使用十六进制、`rgb/rgba` 或 `hsl/hsla`。
- 数字字段只传数字；`bodyLineHeight` 和 `headingLineHeight` 传无单位倍率。
- `effects` 只能使用参考证据中的投影、渐变和透明度；没有证据时传空数组。
- `motion.durations` 使用 `ms` 或 `s`；缓动使用 CSS easing 名称或 `cubic-bezier(...)`。
- `focus` 明确键盘焦点描边宽度、样式、颜色和外移距离，不能用浏览器默认值冒充参考规范。
- `responsive.breakpoints` 只使用采集到的像素断点；`layoutPatterns` 只能使用 `block`、`flex-row`、`flex-column`、`grid`、`sticky`。
- 样式由受信运行器应用，原型文档中不出现 CSS、HTML、脚本、URL 或事件处理器。
- 多页面产品优先使用 `PrototypeDocumentV1.shell` 的顶部或侧边导航，让产品结构在各页面之间保持一致；不得在每个页面复制一套伪导航。

保存失败时，只修正 `PrototypeDocumentV1` 中工具明确指出的问题后再次调用 `save_product_prototype`。若错误来自来源或已锁定设计规范，不得自行修改、补写或重新提交 `design_spec`；应明确告知用户返回设计规范确认页重新处理。
