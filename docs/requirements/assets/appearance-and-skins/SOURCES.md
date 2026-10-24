# 人物主题需求附件来源

更新日期：2026-10-21。所有文件由原文件直接复制，未改变像素内容。截图使用演示数据。

| 文件 | 来源和用途 | SHA256 |
| --- | --- | --- |
| [composition-reference.png](composition-reference.png) | 用户提供的主页构图截图，仅作视觉参考；从旧静态主页稿原样保留 | `595a62309a4b0e8dca3ef6d600018e7ec6deb27372ce969879a9f8171f8f8741` |
| [approved-full.png](approved-full.png) | 已确认的第三稿完整界面，当前 renderer 上的本地视觉原型 | `117241cee3d8eb56f8bf9232706eb3e207d5d6e8ba1e1b9a48818a503d9a615c` |
| [approved-picker.png](approved-picker.png) | 已确认的换肤浮层局部，无人物背景开关 | `ea3cebb28ff2b9de66fe2268e2f7fb2dd43b7d24a1b9338de504f0def6900c02` |
| [sidebar-full-list.png](sidebar-full-list.png) | 50 条演示会话的侧栏背景原型 | `3874a603f2e7b8d8b28c52b4fdb7d2a3dc4973a6cfb584124dbfa98cfa1380be` |
| [blue-character-preview.png](blue-character-preview.png) | 内置 image_gen 根据蓝色参考生成的透明素材，仅作预览 | `9731518b3e1a165b928cfe02d3503977a29d7a05ae7b21205c08481ed476cb9c` |
| [checks/skin-picker-v3-capture.json](checks/skin-picker-v3-capture.json) | 第三稿本地交互与几何检查记录 | `7311fe6b5c5c4e28a36de0f426ff476ecd741befd2fb389012dc866814da0411` |
| [checks/sidebar-watermark-capture.json](checks/sidebar-watermark-capture.json) | 满会话列表背景检查记录 | `36462904e948b637fd5a289fbcea4323365d863a179da1fc5494baf841cc3fb7` |
| [references/blue.jpg](references/blue.jpg) | 用户提供的图 5，晴海蓝参考 | `fd93f12f2d17128afcf759fa1ed81b02101b33bf1b52853f1aad4354ede072e9` |
| [references/purple.jpg](references/purple.jpg) | 用户提供的图 3，月见紫参考 | `8907adafce2486bed84738470e3f283052cdaa5a29d0fecc54fb42d048ef0a7d` |
| [references/orange.jpg](references/orange.jpg) | 用户提供的图 2，焦糖橙参考，原图倒置 | `5aa1172aa53aa43e1e4bb6eb332a18aff95b64c7b4fa3764f65f12e8fe51cc02` |
| [references/gold.jpg](references/gold.jpg) | 用户提供的图 4，蜜糖金参考 | `cb4931761e56c48cc488deba1ea3df308e0690ad2b36ca344ed3ca269596f3c7` |
| [references/red.jpg](references/red.jpg) | 用户提供的图 1，围巾红参考 | `396e21aa544642d504f77f7820a43d3490cecc31b7ae226e4faa86dc99815d8f` |

参考海报不作为生产 UI 整图使用；海报文字、品牌字样与性格标签不进入产品文案或模型配置。正式人物素材需无海报文字，并保留适用的来源和版权声明。

`blue-character-preview.png` 为效果图素材，未代表五款生产资源已经齐备。生产资源清单以主需求为准。

检查 JSON 来自 Vite 上的本地原型，不代表生产 IPC、配置保存、多窗口或打包应用已经验收。

## 蓝色预览素材生成记录

工具：内置 image_gen。模式：参考图片编辑，透明背景。参考：[用户提供的蓝色海报](references/blue.jpg)。提示词原文如下。

```text
Use case: background-extraction / identity-preserve. Edit target: the attached blue poster. Extract ONLY its illustrated blue-haired cat-eared maid character, removing ALL poster background, ALL lettering, ALL logos and checkboxes. Make a clean transparent PNG cutout of the character from the top of her hair and ears through the visible waist, keeping her original detailed anime drawing style, long dark-to-cyan blue hair, the white maid headband, the blue cat ears, wink, cheerful face, blue brooch, navy-and-white modest maid clothing, and her raised hand gesture. Keep her identity, colors, facial expression, and recognizable outfit. Vertical composition, subject centered, no added objects, no phone frame, no UI, no text, no background, genuinely transparent outside the character. This will be used as a small decorative character asset in an existing desktop application's sidebar, so keep the outline clean and every visible hand/hair strand well formed.
```
