// BrandLogo（品牌占位）：公司 LOGO 尚未确认，用干净的"海洋波浪"占位（不放假 logo，不把品牌名塞进色块）。
// 后续公司 logo 确定后，只需替换本组件内部内容即可。
export function BrandLogo({ size = 40, className }: { size?: number; className?: string }) {
  return (
    <div
      className={`relative overflow-hidden rounded-xl bg-gradient-to-br from-brand-600 to-lake-500 ${className ?? ''}`}
      style={{ width: size, height: size }}
      role="img"
      aria-label="品牌 Logo（待定）"
    >
      <svg viewBox="0 0 100 100" className="absolute inset-0 h-full w-full" aria-hidden="true">
        <path d="M0 58 C 22 44, 44 44, 66 58 C 78 66, 90 66, 100 58 L 100 100 L 0 100 Z" fill="rgba(255,255,255,0.16)" />
        <path d="M0 72 C 22 58, 44 58, 66 72 C 78 80, 90 80, 100 72 L 100 100 L 0 100 Z" fill="rgba(255,255,255,0.26)" />
      </svg>
    </div>
  )
}
