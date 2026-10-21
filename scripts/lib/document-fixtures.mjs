// Synthetic, credential-free documents shared by parser and real Electron checks.
import { zipSync, strToU8 } from 'fflate';

export const wordNamespace = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const relNamespace = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const packageNamespace = 'http://schemas.openxmlformats.org/package/2006/relationships';
const sheetNamespace = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const drawingNamespace = 'http://schemas.openxmlformats.org/drawingml/2006/main';
const slideNamespace = 'http://schemas.openxmlformats.org/presentationml/2006/main';
const escapeXml = (text) => String(text).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');

export function officeZip(parts) {
  return zipSync(Object.fromEntries(Object.entries(parts).map(([name, text]) => [name, strToU8(text)])));
}

export function docxFixture(text = 'HEMI_DOCX 项目说明 & 预算') {
  return officeZip({
    'word/document.xml': `<w:document xmlns:w="${wordNamespace}"><w:body><w:p><w:r><w:t>${escapeXml(text)}</w:t></w:r></w:p><w:tbl><w:tr><w:tc><w:p><w:r><w:t>表格内容</w:t></w:r></w:p></w:tc></w:tr></w:tbl></w:body></w:document>`,
  });
}

export function xlsxFixture() {
  return officeZip({
    'xl/workbook.xml': `<workbook xmlns="${sheetNamespace}" xmlns:r="${relNamespace}"><sheets><sheet name="预算" sheetId="2" r:id="second"/><sheet name="人员" sheetId="1" r:id="first"/></sheets></workbook>`,
    'xl/_rels/workbook.xml.rels': `<Relationships xmlns="${packageNamespace}"><Relationship Id="first" Target="worksheets/sheet1.xml"/><Relationship Id="second" Target="worksheets/sheet2.xml"/></Relationships>`,
    'xl/sharedStrings.xml': `<sst xmlns="${sheetNamespace}"><si><t>HEMI_XLSX 收入</t></si></sst>`,
    'xl/styles.xml': `<styleSheet xmlns="${sheetNamespace}"><cellXfs count="3"><xf numFmtId="0"/><xf numFmtId="14"/><xf numFmtId="9"/></cellXfs></styleSheet>`,
    'xl/worksheets/sheet2.xml': `<worksheet xmlns="${sheetNamespace}"><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="C1"><v>1200</v></c></row><row r="2"><c r="A2" t="inlineStr"><is><t>总额</t></is></c><c r="C2"><f>SUM(C1)</f><v>1200</v></c></row><row r="3"><c r="A3" s="1"><v>46316</v></c><c r="C3" s="2"><v>0.25</v></c></row></sheetData></worksheet>`,
    'xl/worksheets/sheet1.xml': `<worksheet xmlns="${sheetNamespace}"><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>张三</t></is></c><c r="D1" t="b"><v>1</v></c></row></sheetData></worksheet>`,
  });
}

export function pptxFixture() {
  const slide = (text) => `<p:sld xmlns:p="${slideNamespace}" xmlns:a="${drawingNamespace}"><p:cSld><p:spTree><p:sp><p:txBody><a:p><a:r><a:t>${escapeXml(text)}</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:sld>`;
  return officeZip({
    'ppt/presentation.xml': `<p:presentation xmlns:p="${slideNamespace}" xmlns:r="${relNamespace}"><p:sldIdLst><p:sldId id="256" r:id="r10"/><p:sldId id="257" r:id="r2"/></p:sldIdLst></p:presentation>`,
    'ppt/_rels/presentation.xml.rels': `<Relationships xmlns="${packageNamespace}"><Relationship Id="r2" Target="slides/slide2.xml"/><Relationship Id="r10" Target="slides/slide10.xml"/></Relationships>`,
    'ppt/slides/slide10.xml': slide('HEMI_PPTX 第一张：计划'),
    'ppt/slides/slide2.xml': slide('第二张：结论'),
  });
}

export function pdfFixture(pages = ['HEMI_PDF first page', 'Second page']) {
  const objects = [null, '<< /Type /Catalog /Pages 2 0 R >>', null,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'];
  const kids = [];
  for (const text of pages) {
    const pageId = objects.length;
    kids.push(`${pageId} 0 R`);
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${pageId + 1} 0 R >>`);
    const escaped = text.replace(/[()\\]/g, '\\$&');
    const stream = text ? `BT /F1 14 Tf 72 720 Td (${escaped}) Tj ET` : '';
    objects.push(`<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`);
  }
  objects[2] = `<< /Type /Pages /Kids [${kids.join(' ')}] /Count ${kids.length} >>`;
  let pdf = '%PDF-1.4\n';
  const offsets = [0];
  for (let index = 1; index < objects.length; index += 1) {
    offsets.push(Buffer.byteLength(pdf));
    pdf += `${index} 0 obj\n${objects[index]}\nendobj\n`;
  }
  const xref = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${objects.length}\n0000000000 65535 f \n`;
  pdf += offsets.slice(1).map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`).join('');
  pdf += `trailer\n<< /Size ${objects.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(pdf);
}
