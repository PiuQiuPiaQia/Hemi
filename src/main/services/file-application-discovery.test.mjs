import assert from 'node:assert/strict';
import test from 'node:test';
import { commonFileApplications } from './file-application-discovery.mjs';

const application = (name, isDefault = false) => ({ name, id: name, isDefault });
test('常用快捷入口按文件类型收敛，Markdown 不列 Excel 或任意关联程序', () => {
  const applications = ['Microsoft Excel', 'Visual Studio Code', '文本编辑', 'Microsoft Word', '预览', 'Safari', 'Cursor', 'Typora'].map(name => application(name));
  applications.unshift(application('任意宽泛关联程序', true));
  assert.deepEqual(commonFileApplications('/a/report.md', applications).map(app => app.name), ['Visual Studio Code', 'Cursor', '文本编辑', 'Typora']);
  assert.deepEqual(commonFileApplications('/a/cover.png', applications).map(app => app.name), ['预览']);
  assert.deepEqual(commonFileApplications('/a/table.xlsx', applications).map(app => app.name), ['Microsoft Excel']);
  assert.deepEqual(commonFileApplications('/a/report.docx', applications).map(app => app.name), ['Microsoft Word', '文本编辑']);
  assert.deepEqual(commonFileApplications('/a/unusual.bin', [application('Default', true)]).map(app => app.name), ['Default']);
});
