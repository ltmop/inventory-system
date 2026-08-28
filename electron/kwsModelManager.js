// 唤醒词（KWS）模型管理：sherpa-onnx-kws-zipformer-wenetspeech-3.3M-2024-01-01（int8 共约 5MB）
// 下载/校验/断点续下逻辑复用 modelManager.js 的 createModelManager 工厂，本文件只声明文件清单与下载源。
//
// 下载源说明：这个 KWS 模型在 HuggingFace 上没有镜像仓库（实测 hf-mirror 401 / 全站搜索无结果），
// 官方只发 GitHub release 整包 tar.bz2（需 bzip2 解码器，与 ASR 模型同样理由不引依赖），
// 因此主源用 ModelScope（pkufool 官方仓库，单文件直链，国内可达），hf-mirror/huggingface 列在后面：
// 哪天 HF 上出现了同名镜像会自动优先走 HF 系。这是"hf-mirror 主源 + huggingface 备用"惯例的唯一例外。
import { createModelManager } from './modelManager.js'

export const KWS_MODEL_NAME = 'sherpa-onnx-kws-zipformer-wenetspeech-3.3M-2024-01-01'

// 期望文件与字节数（与 spike 验证过的模型逐字节一致）
export const KWS_MODEL_FILES = [
  { file: 'encoder-epoch-12-avg-2-chunk-16-left-64.int8.onnx', bytes: 4807159 },
  { file: 'decoder-epoch-12-avg-2-chunk-16-left-64.int8.onnx', bytes: 181025 },
  { file: 'joiner-epoch-12-avg-2-chunk-16-left-64.int8.onnx', bytes: 65208 },
  { file: 'tokens.txt', bytes: 1627 },
]

const mgr = createModelManager({
  files: KWS_MODEL_FILES,
  sources: [
    (file) => `https://hf-mirror.com/csukuangfj/${KWS_MODEL_NAME}/resolve/main/${file}`,
    (file) =>
      `https://modelscope.cn/models/pkufool/${KWS_MODEL_NAME}/resolve/master/${file}`,
    (file) => `https://huggingface.co/csukuangfj/${KWS_MODEL_NAME}/resolve/main/${file}`,
  ],
})

export const checkKwsModel = mgr.checkModel
export const ensureKwsModel = mgr.ensureModel
