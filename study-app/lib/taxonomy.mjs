/**
 * taxonomy.mjs —— 学科体系：大类 → 科目 → 章节
 *
 * 这是整个程序唯一的"知识地图"，后端识别、前端导航、增题归类都从这里取。
 */

export const TAXONOMY = {
  数学: {
    高数: [
      '极限', '连续', '函数', '导数', '微分',
      '一元函数积分学', '多元函数微分学', '多元函数积分学',
      '无穷级数', '微分方程', '向量代数与空间解析几何',
    ],
    线代: ['行列式', '矩阵', '向量', '线性方程组', '特征值与特征向量', '二次型'],
    概率论: [
      '随机事件与概率', '一维随机变量及其分布', '多维随机变量及其分布',
      '随机变量的数字特征', '大数定律与中心极限定理', '数理统计',
    ],
  },
  408: {
    数据结构: ['线性表', '栈队列和数组', '树与二叉树', '图', '查找', '排序'],
    计算机组成原理: ['计算机系统概述', '数据的表示和运算', '存储系统', '指令系统', '中央处理器', '总线', '输入输出系统'],
    操作系统: ['操作系统概述', '进程与线程', '内存管理', '文件管理', '输入输出管理'],
    计算机网络: ['计算机网络体系结构', '物理层', '数据链路层', '网络层', '传输层', '应用层'],
  },
};

// 注意：JS 对象里「像整数的键」会被排到最前，所以 '408' 若从 Object.keys 取会跑到 '数学' 前面。
// 顺序一律以这个显式数组为准。
export const CATEGORIES = ['数学', '408'];

/** 大类 → 科目列表 */
export const SUBJECTS = Object.fromEntries(
  Object.entries(TAXONOMY).map(([cat, subs]) => [cat, Object.keys(subs)])
);

/** 科目 → 所属大类 */
export const SUBJECT_TO_CATEGORY = Object.fromEntries(
  Object.entries(TAXONOMY).flatMap(([cat, subs]) => Object.keys(subs).map((s) => [s, cat]))
);

/** 科目 → 建议章节 */
export const SUBJECT_CHAPTERS = Object.fromEntries(
  Object.entries(TAXONOMY).flatMap(([, subs]) => Object.entries(subs))
);

export const UNCLASSIFIED = '未分类';

/** 识别关键词：先判大类，再判科目 */
const SUBJECT_RULES = {
  数据结构: ['链表', '顺序表', '二叉树', '哈夫曼', '邻接', '邻接矩阵', '图的遍历', '深度优先', '广度优先', '栈', '队列', '串', 'KMP', '散列', '哈希', '堆排序', '快速排序', '归并排序', '时间复杂度', '空间复杂度', '平衡二叉树', 'B树', 'B+树', '最小生成树', '最短路径', '拓扑排序'],
  计算机组成原理: ['补码', '反码', '原码', '移码', '浮点数', 'IEEE', 'cache', 'Cache', '指令', 'CPU', '流水线', '总线', '存储器', '中断', 'DMA', '微程序', '寻址方式', '寄存器', '主存', '磁盘', 'RAID', '校验码', '汉明码'],
  操作系统: ['进程', '线程', '死锁', '银行家算法', '页面置换', '虚拟内存', '分页', '分段', '文件系统', '调度算法', '信号量', 'PV操作', '管程', '临界区', '缓冲区', '磁盘调度', 'inode', '快表', 'TLB', '页表'],
  计算机网络: ['TCP', 'UDP', 'IP地址', '子网', '路由', '以太网', '三次握手', '四次挥手', '拥塞', '端口', 'HTTP', 'DNS', 'ARP', 'CSMA', '数据链路', '物理层', '网络层', '传输层', '应用层', '滑动窗口', 'OSI', '交换机', '网桥', 'VLAN'],
  极限: ['极限', '\\lim', 'lim_', '收敛', '单调有界', '夹逼', '无穷小', '无穷大', '等价无穷', '阶乘'],
  连续: ['连续', '间断', '零点定理', '介值定理', '一致连续', '渐近线'],
  导数: ['导数', '可导', '求导', '中值定理', '罗尔', '拉格朗日', '柯西', '极值', '单调性', '凹凸', '拐点', '高阶导', '驻点'],
  微分: ['微分', '可微', 'dy', '\\mathrm{d}', '近似计算', '泰勒', '麦克劳林'],
  一元函数积分学: ['不定积分', '定积分', '原函数', '反常积分', '变限积分', '换元积分', '分部积分', '定积分的应用'],
  多元函数微分学: ['偏导', '全微分', '方向导数', '梯度', '多元函数'],
  多元函数积分学: ['二重积分', '三重积分', '曲线积分', '曲面积分', '格林公式', '高斯公式', '斯托克斯'],
  无穷级数: ['级数', '幂级数', '傅里叶级数', '收敛半径', '绝对收敛', '条件收敛'],
  微分方程: ['微分方程', '通解', '特解', '齐次方程', '特征方程'],
  向量代数与空间解析几何: ['向量', '平面方程', '直线方程', '曲面', '空间曲线'],
  行列式: ['行列式', '余子式', '代数余子式', '范德蒙'],
  矩阵: ['矩阵', '逆矩阵', '秩', '初等变换', '分块矩阵', '伴随矩阵'],
  线性方程组: ['线性方程组', '基础解系', '同解', '非齐次', '克拉默'],
  向量: ['线性相关', '线性无关', '极大无关组', '向量组'],
  特征值与特征向量: ['特征值', '特征向量', '相似对角化', '实对称矩阵'],
  二次型: ['二次型', '正定', '合同', '标准形', '规范形'],
  随机事件与概率: ['概率', '条件概率', '全概率', '贝叶斯', '独立', '古典概型'],
  一维随机变量及其分布: ['分布函数', '概率密度', '正态分布', '泊松', '均匀分布', '指数分布', '二项分布'],
  多维随机变量及其分布: ['联合分布', '边缘分布', '条件分布', '二维随机变量', '独立性'],
  随机变量的数字特征: ['期望', '方差', '协方差', '相关系数', '矩'],
  大数定律与中心极限定理: ['大数定律', '中心极限定理', '切比雪夫'],
  数理统计: ['样本', '估计量', '极大似然', '置信区间', '假设检验', 't分布', '卡方分布', 'F分布'],
};

/** 章节 → 科目（数学专用；408 的关键词直接就是科目名） */
const CHAPTER_TO_SUBJECT = Object.fromEntries(
  Object.entries(TAXONOMY.数学).flatMap(([sub, chs]) => chs.map((c) => [c, sub]))
);

/**
 * 猜归类。返回 { category, subject, chapter, confidence }
 * 依据关键词命中数打分；一个关键词都没命中就返回「未分类」，交给用户手选。
 */
export function detect(stem) {
  const text = String(stem || '');
  let best = null;
  let bestScore = 0;
  for (const [key, kws] of Object.entries(SUBJECT_RULES)) {
    const score = kws.reduce((s, k) => s + (text.includes(k) ? 1 : 0), 0);
    if (score > bestScore) {
      bestScore = score;
      best = key;
    }
  }
  if (!best) return { category: UNCLASSIFIED, subject: '', chapter: '', confidence: 0 };

  if (SUBJECT_TO_CATEGORY[best] === '408') {
    // 408 的章节名各校教材不同，先不猜，留给用户在下拉里选
    return { category: '408', subject: best, chapter: '', confidence: bestScore };
  }
  return {
    category: '数学',
    subject: CHAPTER_TO_SUBJECT[best] || '高数',
    chapter: best,
    confidence: bestScore,
  };
}

/** 猜题型 */
export function detectType(stem) {
  const t = String(stem || '');
  const prove = t.includes('证明') || t.includes('求证') || t.includes('证：');
  const compute = t.includes('求') || t.includes('计算') || t.includes('解');
  if (prove && compute) return '证明+计算题';
  if (prove) return '证明题';
  if (t.includes('填空') || t.includes('选择')) return '填空/计算题';
  return '计算题';
}

/** 由题干首行生成短标题 */
export function slugOf(stem, maxLen = 14) {
  let s = String(stem || '').split('\n').find((l) => l.trim()) || '新题';
  s = s
    .replace(/\$\$?/g, '')
    .replace(/\\[a-zA-Z]+/g, ' ')
    .replace(/[{}^_]/g, ' ')
    .replace(/[（(][^）)]*[）)]/g, ' ')
    .replace(/[，。；：、,.;:!?！？"'“”]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (s.length > maxLen) s = s.slice(0, maxLen);
  return s || '新题';
}
