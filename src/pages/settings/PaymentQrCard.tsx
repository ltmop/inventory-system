import { useEffect, useState } from 'react'
import { CheckCircle2, Loader2, QrCode, Trash2, Upload } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { backend } from '@/lib/api'

interface QrData {
  wx: string | null
  ali: string | null
}

/** 收款码配置：上传微信/支付宝收款码图片，手机端开单选这两种收款方式时展示给顾客扫 */
export function PaymentQrCard() {
  const [qr, setQr] = useState<QrData>({ wx: null, ali: null })
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null)

  const hasBackend = !!backend

  useEffect(() => {
    if (!backend) return
    backend.invoke('payment:getQr').then(setQr).catch(() => {})
  }, [])

  // 选图 → 压缩到 600px JPEG → 保存
  async function pickAndSave(type: 'wx' | 'ali') {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = 'image/*'
    input.onchange = async () => {
      const file = input.files?.[0]
      if (!file) return
      setBusy(true)
      try {
        const b64 = await compressImage(file)
        const r = await backend!.invoke('payment:saveQr', { type, base64: b64 })
        if (r?.ok) {
          setMsg({ ok: true, text: type === 'wx' ? '微信收款码已保存' : '支付宝收款码已保存' })
          const q = await backend!.invoke('payment:getQr')
          setQr(q)
        } else {
          setMsg({ ok: false, text: r?.error || '保存失败' })
        }
      } catch (e) {
        setMsg({ ok: false, text: e instanceof Error ? e.message : '保存失败' })
      } finally {
        setBusy(false)
      }
    }
    input.click()
  }

  async function remove(type: 'wx' | 'ali') {
    if (!backend) return
    setBusy(true)
    try {
      await backend.invoke('payment:deleteQr', { type })
      setQr((q) => ({ ...q, [type]: null }))
      setMsg({ ok: true, text: type === 'wx' ? '微信收款码已删除' : '支付宝收款码已删除' })
    } catch {
      setMsg({ ok: false, text: '删除失败' })
    } finally {
      setBusy(false)
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <QrCode className="size-5 text-brand-500" />
          收款码
        </CardTitle>
        <CardDescription>
          上传你柜台贴的微信/支付宝收款码。手机端开单选这两种收款方式时，会放大展示给顾客扫码，到账后点完成。这样每天打烊对账就有依据。
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid grid-cols-2 gap-4">
          {(['wx', 'ali'] as const).map((type) => {
            const label = type === 'wx' ? '微信收款码' : '支付宝收款码'
            const img = qr[type]
            return (
              <div key={type} className="rounded-lg border border-input p-3">
                <div className="mb-2 text-sm font-medium">{label}</div>
                {img ? (
                  <div className="space-y-2">
                    <img src={img} alt={label} className="aspect-square w-full rounded-md object-contain" />
                    <Button variant="outline" size="sm" className="w-full text-red-600" onClick={() => remove(type)} disabled={!hasBackend || busy}>
                      <Trash2 className="size-3.5" /> 删除
                    </Button>
                  </div>
                ) : (
                  <div className="flex aspect-square w-full items-center justify-center rounded-md border border-dashed border-muted-foreground/30 text-muted-foreground">
                    <Button variant="outline" size="sm" onClick={() => pickAndSave(type)} disabled={!hasBackend || busy}>
                      {busy ? <Loader2 className="size-3.5 animate-spin" /> : <Upload className="size-3.5" />} 上传图片
                    </Button>
                  </div>
                )}
              </div>
            )
          })}
        </div>
        {msg && (
          <div className={`flex items-start gap-2 rounded-lg px-4 py-3 text-sm ${msg.ok ? 'bg-green-50 text-green-700' : 'bg-red-50 text-red-700'}`}>
            {msg.ok && <CheckCircle2 className="mt-0.5 size-4 shrink-0" />}
            {msg.text}
          </div>
        )}
      </CardContent>
    </Card>
  )
}

/** 图片压缩到 800px JPEG 返回 base64（不含 data: 前缀）。收款码是二维码，对压缩敏感，用高清晰度+高画质保住边角 */
function compressImage(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      const img = new Image()
      img.onload = () => {
        const max = 800
        let { width, height } = img
        if (width > max || height > max) {
          const ratio = Math.min(max / width, max / height)
          width = Math.round(width * ratio)
          height = Math.round(height * ratio)
        }
        const canvas = document.createElement('canvas')
        canvas.width = width
        canvas.height = height
        // 白底垫底：透明/浅色背景的收款码图扫不出来，垫白底提对比度
        const ctx = canvas.getContext('2d')!
        ctx.fillStyle = '#fff'
        ctx.fillRect(0, 0, width, height)
        ctx.drawImage(img, 0, 0, width, height)
        resolve(canvas.toDataURL('image/jpeg', 0.92).split(',')[1])
      }
      img.onerror = () => reject(new Error('图片读取失败'))
      img.src = String(reader.result)
    }
    reader.onerror = () => reject(new Error('图片读取失败'))
    reader.readAsDataURL(file)
  })
}
