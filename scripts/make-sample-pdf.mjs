// 테스트용 최소 PDF 생성기. 외부 의존성 없이 xref 오프셋까지 맞춰 쓴다.
import { writeFileSync } from 'node:fs'

const lines = [
  '3 dan-won: Photosynthesis (Gwanghapseong)',
  '',
  '1. Photosynthesis happens in the chloroplast.',
  '2. It uses light energy, water and carbon dioxide.',
  '3. It produces glucose and oxygen.',
  '4. The light reaction happens in the thylakoid.',
  '5. The Calvin cycle happens in the stroma.',
]

const content =
  'BT /F1 14 Tf 50 780 Td 18 TL\n' +
  lines.map((l) => `(${l.replace(/[()\\]/g, '\\$&')}) Tj T*`).join('\n') +
  '\nET\n'

const objects = [
  '<< /Type /Catalog /Pages 2 0 R >>',
  '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
  '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
  `<< /Length ${content.length} >>\nstream\n${content}endstream`,
  '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
]

let pdf = '%PDF-1.4\n'
const offsets = []
objects.forEach((body, i) => {
  offsets.push(pdf.length)
  pdf += `${i + 1} 0 obj\n${body}\nendobj\n`
})

const xrefStart = pdf.length
pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`
for (const off of offsets) pdf += `${String(off).padStart(10, '0')} 00000 n \n`
pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF\n`

const out = process.argv[2] ?? 'sample.pdf'
writeFileSync(out, pdf, 'latin1')
console.log(`wrote ${out} (${pdf.length} bytes)`)
