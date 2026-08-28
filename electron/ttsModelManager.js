// 语音合成（TTS）模型管理：vits-zh-aishell3 int8（约 42MB，174 个说话人，中文自然度优于系统自带语音）
// 下载/校验/断点续下逻辑复用 modelManager.js 的 createModelManager 工厂，本文件只声明文件清单与下载源。
import { createModelManager } from './modelManager.js'

export const TTS_MODEL_NAME = 'vits-zh-aishell3'

// 期望文件与字节数（与 spike 验证过的模型逐字节一致）
// rule fst（date/number/phone）用于把数字、日期、电话号码读成人话，体积小一并下；
// 仓库里的 new_heteronym.fst 不属于 TTS 规则链（spike 实测加进 ruleFsts 会让引擎崩溃），不下
export const TTS_MODEL_FILES = [
  { file: 'vits-aishell3.int8.onnx', bytes: 39870124 },
  { file: 'lexicon.txt', bytes: 2042943 },
  { file: 'tokens.txt', bytes: 1671 },
  { file: 'date.fst', bytes: 59154 },
  { file: 'number.fst', bytes: 64482 },
  { file: 'phone.fst', bytes: 88630 },
]

const mgr = createModelManager({
  files: TTS_MODEL_FILES,
  sources: [
    (file) => `https://hf-mirror.com/csukuangfj/${TTS_MODEL_NAME}/resolve/main/${file}`,
    (file) => `https://huggingface.co/csukuangfj/${TTS_MODEL_NAME}/resolve/main/${file}`,
  ],
})

export const checkTtsModel = mgr.checkModel
export const ensureTtsModel = mgr.ensureModel
