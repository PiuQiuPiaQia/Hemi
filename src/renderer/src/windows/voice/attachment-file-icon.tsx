import { FileText } from 'lucide-react';
import pdfIcon from '../../assets/file-types/pdf.svg';
import wordIcon from '../../assets/file-types/word.svg';
import excelIcon from '../../assets/file-types/table.svg';
import powerpointIcon from '../../assets/file-types/powerpoint.svg';
import imageIcon from '../../assets/file-types/image.svg';

const fileIcons: Record<string, string> = {
  pdf: pdfIcon, docx: wordIcon, xlsx: excelIcon, pptx: powerpointIcon,
};

export function attachmentTypeLabel(name: string) {
  const leaf = name.split(/[\\/]/).pop() ?? name;
  const dot = leaf.lastIndexOf('.');
  return dot > 0 && dot < leaf.length - 1 ? leaf.slice(dot + 1).toUpperCase() : '文件';
}

export function AttachmentFileIcon({ name, kind }: { name: string; kind?: string }) {
  const extension = name.split('.').pop()?.toLowerCase() ?? '';
  const src = kind === 'image' ? imageIcon : fileIcons[extension];
  return src ? <img className="h-attachment-file-icon" src={src} alt="" aria-hidden="true" draggable={false} />
    : <FileText className="h-attachment-file-icon" aria-hidden="true" />;
}
