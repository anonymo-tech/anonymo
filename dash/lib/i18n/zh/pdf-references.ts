import type { Dictionary } from '../index.ts';

export default {
  'There is no room for reference text within the input limit. Nothing was attached.':
    '输入上限内已无足够空间容纳参考文本，未添加任何附件。',
  'This PDF has no readable text (it may be a scan). Nothing was attached.':
    '此 PDF 没有可读取的文本（可能是扫描件），未添加任何附件。',
  'This PDF has too little readable text to use as a reference (it may be a scan). Nothing was attached.':
    '此 PDF 的可读取文本过少，无法用作参考（可能是扫描件）。未添加任何附件。',
  'This PDF is password-protected. Nothing was attached.':
    '此 PDF 受密码保护，未添加任何附件。',
  'This PDF could not be read. It may be damaged or unsupported. Nothing was attached.':
    '无法读取此 PDF，文件可能已损坏或格式不受支持。未添加任何附件。',
  'Your draft or project changed while reading. Choose the file again.':
    '读取期间草稿或项目发生了变化，请重新选择文件。',
  'Reference text was added to your draft. Review it before sending. Images remain local only.':
    '参考文本已添加到草稿，请在发送前检查。图片仍仅保留在本地。',
  'The reference could not be read. Nothing was attached.':
    '无法读取参考文件，未添加任何附件。',
  'Wait for the reference text to finish loading.': '请等待参考文本加载完成。',
  'Reading reference text…': '正在读取参考文本…',
  'Remove reference text: {name}': '移除参考文本：{name}',
  '{count} page': '{count} 页',
  '{count} pages': '{count} 页',
  'Pages 1–{read} of {total} were read.':
    '已读取共 {total} 页中的第 1–{read} 页。',
  'Page {page} was kept only in part; {bytes} bytes of extracted text were kept in total.':
    '第 {page} 页仅保留了部分文本；提取的文本共保留 {bytes} 字节。',
  'Kept the first {bytes} bytes of text.': '保留了文本的前 {bytes} 字节。',
  'Text is in your draft. PDF images are not read. Review before sending.':
    '文本已加入草稿。PDF 中的图片不会被读取，请在发送前检查。',
} satisfies Dictionary;
