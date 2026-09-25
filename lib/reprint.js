'use strict';

const { PDFDocument } = require('pdf-lib');
const { imposePdf } = require('./impose');

/**
 * 缺页补印核心逻辑。
 *
 * 印刷完成后若部分原稿页受损，无需重印整册：输入受损的原稿页码或区间
 * （如 "2,5-7"），服务端按本次拼版选项（整册/分册签帖、定位标记、
 * 骑马钉爬移补偿与纸厚）复用拼版方案，在每张纸的正/背面四个槽位中定位
 * 受损页码所在的印张：
 *   - 同一印张命中多个受损页时只补印一次；
 *   - 分册签帖模式下累计各帖的输出页偏移（每帖占 2 × 帖内张数个输出页），
 *     据此把帖内张号换算为完整拼版输出中的页码；
 *   - 按原印张顺序从完整拼版输出中成对抽取正、背面，组成补印 PDF，
 *     印张尺寸、定位标记与爬移平移/半区裁切与原拼版输出完全一致
 *     （逐页原样复制）。
 */

/**
 * 补印页码输入错误（空输入、格式错误、越界页码），HTTP 层据此返回 400。
 */
class ReprintInputError extends Error {}

/**
 * 把页码文本转换为安全整数；超出安全整数范围（绝对值 > 2^53-1）的页码
 * 无法精确表示（如 9007199254740992 加 1 后仍是自身，逐页展开将永远无法
 * 前进），直接抛出 ReprintInputError。
 *
 * @param {string} text 纯数字文本
 * @param {string} token 原始片段（用于错误信息）
 * @returns {number} 安全整数页码
 */
function toSafePageNumber(text, token) {
  const value = Number(text);
  if (!Number.isSafeInteger(value)) {
    throw new ReprintInputError(
      `页码「${token}」超出可精确表示的整数范围（最大 ${Number.MAX_SAFE_INTEGER}）`,
    );
  }
  return value;
}

/**
 * 解析补印页码表达式的词法部分，返回安全整数区间列表（不展开、不做越界校验）。
 *
 * 接受逗号分隔的单个页码与区间（如 "2,5-7"），允许空白字符；
 * 全角逗号「，」与全角/长破折号「～～–—―」按半角处理。
 * 单页视为起点=终点的区间；区间允许重叠（展开时去重）。
 * 空输入、无法识别的片段、起点大于终点、端点超出安全整数范围
 * 都抛出 ReprintInputError。
 *
 * @param {*} input 用户输入（缺失/非字符串按空输入处理）
 * @returns {Array<{ from: number, to: number }>} 区间列表（保持输入顺序，未展开）
 */
function parseReprintPageRanges(input) {
  const raw = input === undefined || input === null ? '' : String(input);
  if (raw.trim() === '') {
    throw new ReprintInputError('请输入需要补印的原稿页码或区间（如 2,5-7）');
  }
  const normalized = raw.replace(/，/g, ',').replace(/[～~–—―]/g, '-');
  const ranges = [];
  for (const rawToken of normalized.split(',')) {
    const token = rawToken.trim();
    if (token === '') {
      throw new ReprintInputError('页码格式错误：存在空的页码项（多余的逗号），正确形式如 2,5-7');
    }
    const range = /^(\d+)\s*-\s*(\d+)$/.exec(token);
    if (range) {
      const from = toSafePageNumber(range[1], token);
      const to = toSafePageNumber(range[2], token);
      if (from > to) {
        throw new ReprintInputError(`页码区间「${token}」的起点不能大于终点`);
      }
      ranges.push({ from, to });
    } else if (/^\d+$/.test(token)) {
      const page = toSafePageNumber(token, token);
      ranges.push({ from: page, to: page });
    } else {
      throw new ReprintInputError(
        `页码格式错误：无法识别「${token}」（支持单个页码与区间，如 2,5-7）`,
      );
    }
  }
  return ranges;
}

/**
 * 越界校验（在展开页码列表之前，仅检查区间端点）：页码为 1 基，
 * 必须落在 1～sourceCount 内。错误信息最多列出 10 个越界页码，
 * 更多时以「等（共 N 页）」概括，避免超大区间产生超长信息。
 *
 * @param {Array<{ from: number, to: number }>} ranges 区间列表
 * @param {number} sourceCount 原稿总页数
 * @returns {Array<{ from: number, to: number }>} 原样返回 ranges
 */
function assertRangesInRange(ranges, sourceCount) {
  const samples = [];
  let total = 0;
  const collect = (lo, hi) => {
    if (lo > hi) return;
    total += hi - lo + 1;
    for (let page = lo; page <= hi && samples.length < 10; page += 1) samples.push(page);
  };
  for (const { from, to } of ranges) {
    collect(from, Math.min(to, 0));               // 小于 1 的部分（仅可能为 0）
    collect(Math.max(from, sourceCount + 1), to); // 超过总页数的部分
  }
  if (total > 0) {
    const suffix = total > samples.length ? ` 等（共 ${total} 页）` : '';
    throw new ReprintInputError(
      `页码 ${samples.join('、')}${suffix} 超出原稿页码范围（1～${sourceCount}）`,
    );
  }
  return ranges;
}

/**
 * 把区间列表展开为升序去重的页码数组（重叠区间自然去重）。
 * 区间端点均为安全整数，递增必然前进、循环必然终止；调用前应先完成
 * 越界校验（端点落在 1～sourceCount 内），展开规模即以原稿页数为界。
 *
 * @param {Array<{ from: number, to: number }>} ranges 区间列表
 * @returns {number[]} 升序去重后的页码数组
 */
function expandReprintRanges(ranges) {
  const pages = new Set();
  for (const { from, to } of ranges) {
    for (let page = from; page <= to; page += 1) pages.add(page);
  }
  return [...pages].sort((a, b) => a - b);
}

/**
 * 解析补印页码表达式的词法部分（不做越界校验）。
 * 等价于先解析为安全整数区间再展开；非安全整数端点在此即被拒绝。
 *
 * @param {*} input 用户输入（缺失/非字符串按空输入处理）
 * @returns {number[]} 升序去重后的页码数组（未做越界校验）
 */
function parseReprintPagesSpec(input) {
  return expandReprintRanges(parseReprintPageRanges(input));
}

/**
 * 解析并校验补印页码表达式（词法 + 越界）。
 * 先解析为安全整数区间并以原稿页数校验端点，通过后才展开页码列表，
 * 超大区间在展开前即被拒绝。
 *
 * @param {*} input 用户输入
 * @param {number} sourceCount 原稿总页数
 * @returns {number[]} 升序去重后的合法页码数组
 */
function parseReprintPages(input, sourceCount) {
  return expandReprintRanges(assertRangesInRange(parseReprintPageRanges(input), sourceCount));
}

/**
 * 仅加载原 PDF 并返回页数（与 imposePdf 的加载校验完全一致：
 * 损坏/加密报「不是有效的 PDF」，0 页报「不包含任何页面」）。
 * 用于在生成页码列表与完整拼版之前取得原稿页数做越界校验。
 *
 * @param {Buffer|Uint8Array} sourceBytes 原始 PDF 字节
 * @returns {Promise<number>} 原稿总页数
 */
async function loadSourcePageCount(sourceBytes) {
  let srcDoc;
  try {
    srcDoc = await PDFDocument.load(sourceBytes, { ignoreEncryption: false });
    // 触发一次页树读取，损坏/被截断的文件会在此处暴露异常
    srcDoc.getPageCount();
  } catch (err) {
    throw new Error('文件不是有效的 PDF（可能已损坏或被加密）');
  }
  const sourceCount = srcDoc.getPageCount();
  if (sourceCount === 0) {
    throw new Error('PDF 不包含任何页面');
  }
  return sourceCount;
}

/**
 * 在拼版方案中定位受损页码所在的印张。
 *
 * 逐张纸检查正/背面四个槽位：同一印张命中多个受损页时只记录一次；
 * 结果按原印张输出顺序排列。分册签帖模式下累计各帖的输出页偏移
 * （每帖占 2 × 帖内张数个输出页），给出每张命中印张在完整拼版输出
 * 中的 1 基页码区间（正面、背面）。
 *
 * @param {object} plan 拼版方案（整册或分册签帖，与 imposePdf 返回的一致）
 * @param {number[]} pages 受损页码（1 基）
 * @returns {Array<{
 *   signature: number|null, sheet: number, signatureSheetCount: number|null,
 *   hitPages: number[], outputPages: [number, number], creepShiftMm: number
 * }>}
 */
function buildReprintPlan(plan, pages) {
  const wanted = new Set(pages);
  const hits = [];
  let outputOffset = 0; // 当前帖之前已输出的页数（分册模式下逐帖累计）

  const visitSheet = (sheet, signature) => {
    const hitPages = [];
    for (const side of ['front', 'back']) {
      for (const pos of ['left', 'right']) {
        const slot = sheet[side][pos];
        if (!slot.blank && wanted.has(slot.page)) {
          hitPages.push(slot.page);
        }
      }
    }
    if (hitPages.length === 0) return;
    const frontPage = outputOffset + (sheet.sheet - 1) * 2 + 1; // 1 基输出页码（正面）
    hits.push({
      signature: signature ? signature.signature : null,
      sheet: sheet.sheet,
      signatureSheetCount: signature ? signature.sheets.length : null,
      hitPages: hitPages.sort((a, b) => a - b),
      outputPages: [frontPage, frontPage + 1],
      creepShiftMm: sheet.creep ? sheet.creep.shiftMm : 0,
    });
  };

  if (plan.signatureMode) {
    for (const signature of plan.signatures) {
      for (const sheet of signature.sheets) visitSheet(sheet, signature);
      outputOffset += signature.sheets.length * 2;
    }
  } else {
    for (const sheet of plan.sheets) visitSheet(sheet, null);
  }
  return hits;
}

/**
 * 生成缺页补印 PDF。
 *
 * 复用拼版方案：按与 /api/impose 完全相同的选项重建完整拼版
 * （整册/分册签帖、定位标记），在方案中定位受损页码所在印张，
 * 再按原印张顺序从拼版输出中成对抽取正、背面组成补印 PDF。
 * 补印页为拼版输出页的逐页原样复制，印张尺寸与定位标记保持不变。
 *
 * @param {Buffer|Uint8Array} sourceBytes 原始 PDF 字节
 * @param {{ maxSheetsPerSignature?: number, registrationMarks?: boolean,
 *           creepCompensation?: boolean, paperThicknessMm?: number|string }} [options]
 *        与 imposePdf 相同的拼版选项
 * @param {*} pagesInput 受损页码表达式（如 "2,5-7"）
 * @returns {Promise<{ pdfBytes: Uint8Array, reprint: object }>}
 *          reprint 为补印方案：pages（升序去重的受损页码）、sheetCount、
 *          pageCount、signatureMode、creep 与每张补印纸的帖号/帖内张号/
 *          命中页码/原输出页码/爬移单侧内移量
 */
async function reprintPdf(sourceBytes, options = {}, pagesInput) {
  // 先做词法校验（空输入/格式错误/非安全整数端点），解析为区间列表，不展开页码
  const ranges = parseReprintPageRanges(pagesInput);

  // 越界校验需要原稿页数：仅加载 PDF 取页数（损坏/加密 PDF 在此按原规则报错），
  // 在生成页码列表与完整拼版之前拒绝越界区间，超大区间不会耗尽时间与内存
  const sourceCount = await loadSourcePageCount(sourceBytes);
  assertRangesInRange(ranges, sourceCount);

  // 端点已落在 1～sourceCount 内，展开规模以原稿页数为界
  const pages = expandReprintRanges(ranges);

  // 复用拼版方案：与本次拼版相同的选项重建完整拼版输出
  const { pdfBytes, plan } = await imposePdf(sourceBytes, options);

  const sheets = buildReprintPlan(plan, pages);

  // 按原印张顺序成对抽取正、背面（输出页 1 基转 0 基索引）
  const imposedDoc = await PDFDocument.load(pdfBytes);
  const indices = [];
  for (const hit of sheets) {
    indices.push(hit.outputPages[0] - 1, hit.outputPages[1] - 1);
  }
  const outDoc = await PDFDocument.create();
  const copied = await outDoc.copyPages(imposedDoc, indices);
  for (const page of copied) outDoc.addPage(page);
  outDoc.setTitle(`缺页补印（${pages.length} 页受损 / ${sheets.length} 张纸）`);
  outDoc.setProducer('booklet-imposer (pdf-lib)');
  const reprintBytes = await outDoc.save();

  return {
    pdfBytes: reprintBytes,
    reprint: {
      schemaVersion: 1,
      kind: 'reprint-plan',
      tool: 'booklet-imposer',
      pages,
      sheetCount: sheets.length,
      pageCount: indices.length,
      signatureMode: Boolean(plan.signatureMode),
      creep: plan.creep || { enabled: false, paperThicknessMm: 0 },
      sheets,
    },
  };
}

module.exports = {
  ReprintInputError,
  parseReprintPageRanges,
  parseReprintPagesSpec,
  parseReprintPages,
  buildReprintPlan,
  reprintPdf,
};
