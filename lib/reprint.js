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
 * 把页码数字串转换为安全整数。
 *
 * 超出安全整数范围（绝对值大于 2^53－1）的页码必须拒绝：双精度浮点中
 * 2^53 + 1 仍等于 2^53，若接受此类页码，后续逐页递增（page += 1）将永远
 * 无法前进，区间展开会陷入死循环并阻塞事件循环。
 *
 * @param {string} digits 页码数字串（已匹配 /^\d+$/）
 * @param {string} token 原始片段（用于错误信息）
 * @returns {number} 安全整数页码
 */
function toSafePageNumber(digits, token) {
  const value = Number(digits);
  if (!Number.isSafeInteger(value)) {
    throw new ReprintInputError(
      `页码「${token}」超出可表示的页码上限（${Number.MAX_SAFE_INTEGER}）`,
    );
  }
  return value;
}

/**
 * 解析补印页码表达式的词法部分，输出安全整数区间列表（不展开、不做越界校验）。
 *
 * 接受逗号分隔的单个页码与区间（如 "2,5-7"），允许空白字符；
 * 全角逗号「，」与全角/长破折号「～～–—―」按半角处理。
 * 空输入、任何无法识别的片段、非安全整数页码都抛出 ReprintInputError。
 *
 * 解析结果保持区间形态（单页为 from === to），调用方据此可以在展开页码
 * 列表之前先校验区间端点，避免远超原稿页数的区间在越界检查前耗尽时间与内存。
 *
 * @param {*} input 用户输入（缺失/非字符串按空输入处理）
 * @returns {Array<{ from: number, to: number }>} 按输入顺序的区间列表（未做越界校验）
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
 * 区间端点越界校验：页码为 1 基，每个区间的起点与终点都必须落在
 * 1～sourceCount 内（端点合法即区间内全部页码合法，无需展开即可判断）。
 *
 * @param {Array<{ from: number, to: number }>} ranges 区间列表
 * @param {number} sourceCount 原稿总页数
 * @returns {Array<{ from: number, to: number }>} 原样返回 ranges
 */
function assertRangesInRange(ranges, sourceCount) {
  const outOfRange = new Set();
  for (const { from, to } of ranges) {
    if (from < 1 || from > sourceCount) outOfRange.add(from);
    if (to < 1 || to > sourceCount) outOfRange.add(to);
  }
  if (outOfRange.size) {
    const list = [...outOfRange].sort((a, b) => a - b);
    throw new ReprintInputError(
      `页码 ${list.join('、')} 超出原稿页码范围（1～${sourceCount}）`,
    );
  }
  return ranges;
}

/**
 * 把区间列表展开为升序去重的页码数组（重叠区间自然去重）。
 *
 * 调用前必须先完成区间端点越界校验（assertRangesInRange），确保展开规模
 * 受原稿页数约束；端点均为安全整数且 from <= to，逐页递增必然终止。
 *
 * @param {Array<{ from: number, to: number }>} ranges 区间列表
 * @returns {number[]} 升序去重后的页码数组
 */
function expandReprintPageRanges(ranges) {
  const pages = new Set();
  for (const { from, to } of ranges) {
    for (let page = from; page <= to; page += 1) pages.add(page);
  }
  return [...pages].sort((a, b) => a - b);
}

/**
 * 解析补印页码表达式的词法部分（不做越界校验）。
 *
 * 词法规则与 parseReprintPageRanges 相同，结果展开为升序去重的页码数组。
 * 注意：本函数不做越界校验，区间展开规模不受原稿页数约束；需要越界校验时
 * 请使用 parseReprintPages（先校验区间端点再展开）。
 *
 * @param {*} input 用户输入（缺失/非字符串按空输入处理）
 * @returns {number[]} 升序去重后的页码数组（未做越界校验）
 */
function parseReprintPagesSpec(input) {
  return expandReprintPageRanges(parseReprintPageRanges(input));
}

/**
 * 越界校验：页码为 1 基，必须落在 1～sourceCount 内。
 *
 * 针对已展开的页码数组逐页校验；补印主流程（parseReprintPages /
 * reprintPdf）改用区间端点校验（assertRangesInRange），在展开前完成。
 * 本函数保留给已持有展开页码列表的调用方。
 *
 * @param {number[]} pages 升序页码数组
 * @param {number} sourceCount 原稿总页数
 * @returns {number[]} 原样返回 pages
 */
function assertPagesInRange(pages, sourceCount) {
  const outOfRange = pages.filter((page) => page < 1 || page > sourceCount);
  if (outOfRange.length) {
    throw new ReprintInputError(
      `页码 ${outOfRange.join('、')} 超出原稿页码范围（1～${sourceCount}）`,
    );
  }
  return pages;
}

/**
 * 解析并校验补印页码表达式（词法 + 越界）。
 *
 * 先解析为安全整数区间并以原稿页数校验区间端点，通过后再展开为页码
 * 列表——远超原稿页数的区间在展开前即被拒绝，不会耗尽时间与内存。
 *
 * @param {*} input 用户输入
 * @param {number} sourceCount 原稿总页数
 * @returns {number[]} 升序去重后的合法页码数组
 */
function parseReprintPages(input, sourceCount) {
  return expandReprintPageRanges(
    assertRangesInRange(parseReprintPageRanges(input), sourceCount),
  );
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
 * 读取原稿 PDF 的页数（仅加载解析，不做拼版）。
 *
 * 加载与错误规则与 imposePdf 完全一致：损坏/被截断/加密的文件报
 * 「文件不是有效的 PDF」，0 页文档报「PDF 不包含任何页面」。
 * 用于在展开页码列表与执行完整拼版之前取得原稿页数以校验区间端点。
 *
 * @param {Buffer|Uint8Array} sourceBytes 原始 PDF 字节
 * @returns {Promise<number>} 原稿总页数（>= 1）
 */
async function readSourcePageCount(sourceBytes) {
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
 * 生成缺页补印 PDF。
 *
 * 处理顺序（非法输入尽早拒绝，不做无谓的拼版计算）：
 *   1. 词法解析为安全整数区间（不展开）：空输入、格式错误、非安全整数
 *      页码（如 2^53，逐页递增无法前进）在此抛出 ReprintInputError；
 *   2. 加载原稿读取页数（损坏/加密 PDF 按原规则报错）；
 *   3. 以原稿页数校验区间端点，越界抛出 ReprintInputError——此步在展开
 *      页码列表与完整拼版之前，远超原稿页数的区间不会耗尽时间与内存；
 *   4. 展开为升序去重的页码列表（规模已受原稿页数约束）；
 *   5. 复用拼版方案：按与 /api/impose 完全相同的选项重建完整拼版
 *      （整册/分册签帖、定位标记），在方案中定位受损页码所在印张，
 *      再按原印张顺序从拼版输出中成对抽取正、背面组成补印 PDF。
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
  // 1. 词法校验（空输入/格式错误/非安全整数页码），避免无效输入仍读取 PDF
  const ranges = parseReprintPageRanges(pagesInput);

  // 2. 读取原稿页数（损坏/加密 PDF 在此按原规则报错）
  const sourceCount = await readSourcePageCount(sourceBytes);

  // 3. 区间端点越界校验 + 4. 展开页码列表（均在完整拼版之前完成）
  const pages = expandReprintPageRanges(assertRangesInRange(ranges, sourceCount));

  // 5. 复用拼版方案：与本次拼版相同的选项重建完整拼版输出
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
  assertRangesInRange,
  expandReprintPageRanges,
  parseReprintPagesSpec,
  parseReprintPages,
  assertPagesInRange,
  readSourcePageCount,
  buildReprintPlan,
  reprintPdf,
};
