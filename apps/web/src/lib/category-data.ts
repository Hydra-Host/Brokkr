import amdLogo from '../assets/amd-logo.png';
import intelLogo from '../assets/intel-logo.png';
import nvidiaLogo from '../assets/nvidia-logo.png';

export const inventoryCategories = [
  {
    name: 'NVIDIA B300',
    chipset: 'B300',
    manufacturers: ['NVIDIA'],
    description:
      'The NVIDIA B300 represents the next evolution in the Blackwell architecture, delivering enhanced performance for the most demanding AI workloads. Built for training and deploying large-scale AI models, B300 offers improved efficiency and performance over its predecessors. With advanced NVLink interconnect and optimized memory bandwidth, it is ideal for LLMs, recommender systems, and real-time inference applications requiring maximum computational power.',
    badgeList: [
      'AI Acceleration',
      'Advanced Architecture',
      'NVLink Switch System',
      'High-Performance Computing (HPC)',
      'Scalable Multi-Node Training',
      'FP8 Precision',
      'Efficient AI Infrastructure',
    ],
    brandImages: [nvidiaLogo],
    startPrice: 3.4,
    priceFrequency: '/hr',
    ctaButtonLabel: 'See Inventory',
    ctaButtonHref: '/inventory/category/b300',
    hasPreorder: true,
    hasOnDemand: true,
    hasReserve: true,
    hasCluster: false,
  },
  {
    name: 'NVIDIA B200',
    chipset: 'B200',
    manufacturers: ['NVIDIA'],
    description:
      'The Foundation for your AI Factory. NVIDIA B200 is a next-generation GPU built for training and deploying the most demanding AI workloads. Servers powered by 8 Blackwell GPUs and fifth-gen NVLink interconnect, deliver up to 3x training and 15x inference performance over predecessors. Ideal for LLMs, recommender systems, and real-time inference applications, B200 is a high-performance chip designed for teams scaling production AI infrastructure with confidence.',
    badgeList: [
      'AI Acceleration',
      'Advanced Architecture',
      'NVLink Switch System',
      'High-Performance Computing (HPC)',
      'Scalable Multi-Node Training',
      'FP8 Precision',
      'Efficient AI Infrastructure',
    ],
    brandImages: [nvidiaLogo],
    startPrice: 2.85,
    priceFrequency: '/hr',
    ctaButtonLabel: 'See Inventory',
    ctaButtonHref: '/inventory/category/b200',
    hasPreorder: true,
    hasOnDemand: true,
    hasReserve: true,
    hasCluster: false,
  },
  {
    name: 'NVIDIA GB200',
    chipset: 'GB200',
    manufacturers: ['NVIDIA'],
    description:
      'The NVIDIA GB200 Grace Blackwell Superchip combines the power of Grace CPU and Blackwell GPU in a single, unified architecture. Designed for AI supercomputing, GB200 delivers exceptional performance for training and inference of trillion-parameter models. With high-bandwidth memory and seamless CPU-GPU integration, it is perfect for large-scale AI training, scientific computing, and data analytics requiring massive computational capabilities.',
    badgeList: [
      'AI Supercomputing',
      'Grace CPU + Blackwell GPU',
      'Unified Architecture',
      'High-Bandwidth Memory',
      'Trillion-Parameter Models',
      'CPU-GPU Integration',
      'Large-Scale AI Training',
    ],
    brandImages: [nvidiaLogo],
    startPrice: 3.25,
    priceFrequency: '/hr',
    ctaButtonLabel: 'See Inventory',
    ctaButtonHref: '/inventory/category/gb200',
    hasPreorder: true,
    hasOnDemand: true,
    hasReserve: true,
    hasCluster: false,
  },
  {
    name: 'NVIDIA GB300',
    chipset: 'GB300',
    manufacturers: ['NVIDIA'],
    description:
      'The NVIDIA GB300 Grace Blackwell Superchip represents the pinnacle of AI supercomputing technology. Building on the GB200 architecture, GB300 offers enhanced performance and efficiency for the most demanding AI and HPC workloads. With advanced Grace CPU and Blackwell GPU integration, ultra-high-bandwidth memory, and optimized interconnects, GB300 is engineered for training and deploying the largest AI models at unprecedented scale.',
    badgeList: [
      'AI Supercomputing',
      'Grace CPU + Blackwell GPU',
      'Unified Architecture',
      'Ultra-High-Bandwidth Memory',
      'Trillion-Parameter Models',
      'Advanced CPU-GPU Integration',
      'Extreme-Scale AI Training',
    ],
    brandImages: [nvidiaLogo],
    startPrice: 3.5,
    priceFrequency: '/hr',
    ctaButtonLabel: 'See Inventory',
    ctaButtonHref: '/inventory/category/gb300',
    hasPreorder: true,
    hasOnDemand: true,
    hasReserve: true,
    hasCluster: false,
  },
  {
    name: 'NVIDIA H200',
    chipset: 'H200',
    manufacturers: ['NVIDIA'],
    description:
      "Introducing the NVIDIA H200, NVIDIA's cutting-edge data center GPU designed for the next generation of AI and HPC applications. The H200 is built to deliver unparalleled performance and efficiency, supporting a wide range of workloads with its advanced architecture. With multiple configuration options, the H200 empowers organizations to accelerate their AI and HPC initiatives, driving innovation and maximizing computational power.",
    badgeList: [
      'AI Acceleration',
      'High-Performance Computing (HPC)',
      'Advanced Architecture',
      'Scalability',
      'Efficiency',
    ],
    brandImages: [nvidiaLogo],
    startPrice: 2.5,
    priceFrequency: '/hr',
    ctaButtonLabel: 'See Inventory',
    ctaButtonHref: '/inventory/category/h200',
    hasPreorder: true,
    hasOnDemand: true,
    hasReserve: true,
    hasCluster: false,
  },
  {
    name: 'NVIDIA H100',
    chipset: 'H100',
    manufacturers: ['NVIDIA'],
    description:
      "Introducing the NVIDIA H100, NVIDIA's latest data center GPU built for AI and HPC convergence. It is engineered for universal workloads, offering servers with various H100 configurations to meet different performance and efficiency requirements, enabling both innovation and optimization.",
    badgeList: ['All Inference', 'Machine Learning', 'High Performance Computing', 'Simulation', 'Data Centers'],
    brandImages: [nvidiaLogo],
    startPrice: 2.3,
    priceFrequency: '/hr',
    ctaButtonLabel: 'See Inventory',
    ctaButtonHref: '/inventory/category/h100',
    hasPreorder: true,
    hasOnDemand: true,
    hasReserve: true,
    hasCluster: false,
  },
  {
    name: 'NVIDIA A100',
    chipset: 'A100',
    manufacturers: ['NVIDIA'],
    description:
      "The NVIDIA A100 delivers balanced performance for both AI training and inference at every scale, as well as for data analytics, and high-performance computing (HPC) to tackle the world's toughest computing challenges. This category offers servers equipped with the A100 for diverse needs, from dual-card setups for balanced power and efficiency to multi-GPU configurations for the most demanding tasks. New supply of A100s are hard to come by as they have been discontinued in favor of newer models, so both on demand and pre-order options are highly demanded.",
    badgeList: ['AI', 'Deep Learning', 'HPC', 'Data Analytics', 'Scientific Computing'],
    brandImages: [nvidiaLogo],
    startPrice: 1.19,
    priceFrequency: '/hr',
    ctaButtonLabel: 'See Inventory',
    ctaButtonHref: '/inventory/category/a100',
    hasPreorder: true,
    hasOnDemand: true,
    hasReserve: true,
    hasCluster: false,
  },
  {
    name: 'NVIDIA V100',
    chipset: 'V100',
    manufacturers: ['NVIDIA'],
    description:
      'The NVIDIA V100 is a high-performance GPU designed for AI, deep learning, and high-performance computing workloads. Powered by the Volta architecture, it delivers exceptional parallel processing capabilities, accelerating model training, scientific simulations, and data analytics. With Tensor Cores for AI inference and FP64 precision for computational tasks, the V100 is ideal for research institutions, enterprises, and cloud-based AI solutions, offering unmatched efficiency and scalability.',
    badgeList: [
      'AI & Deep Learning',
      'High-Performance Computing',
      'Scientific Computing',
      'Data Analytics',
      'Cloud & Virtualization',
    ],
    brandImages: [nvidiaLogo],
    startPrice: 0.29,
    priceFrequency: '/hr',
    ctaButtonLabel: 'See Inventory',
    ctaButtonHref: '/inventory/category/v100',
    hasPreorder: true,
    hasOnDemand: true,
    hasReserve: true,
    hasCluster: true,
  },
  {
    name: 'NVIDIA GH200',
    chipset: 'GH200',
    manufacturers: ['NVIDIA'],
    description:
      'The NVIDIA GH200, designed for top-tier AI and computing tasks, offers configurations from single to multi-GPU systems, ideal for both specific tasks and intensive AI training, setting new standards in computational power and efficiency.',
    badgeList: [
      'Advanced AI Research',
      'Complex Data Analytics',
      'High-End 3D Rendering',
      'Large-Scale Scientific Simulations',
      'Real-Time Ray Tracing',
    ],
    brandImages: [nvidiaLogo],
    startPrice: 2.23,
    priceFrequency: '/hr',
    ctaButtonLabel: 'See Inventory',
    ctaButtonHref: '/inventory/category/gh200',
    hasPreorder: true,
    hasOnDemand: true,
    hasReserve: true,
    hasCluster: false,
  },
  {
    name: 'NVIDIA L40S',
    chipset: 'L40S',
    manufacturers: ['NVIDIA'],
    description:
      'The NVIDIA L40S server configurations deliver top-tier performance for graphics-intensive and AI-driven applications. Options range from single L40S servers for high-end gaming and professional visualization to multi-GPU servers for advanced AI research and complex 3D rendering.',
    badgeList: ['AI Research', '3D Rendering', 'Professional Visualization', 'Data Analytics', 'Machine Learning'],
    brandImages: [nvidiaLogo],
    startPrice: 0.85,
    priceFrequency: '/hr',
    ctaButtonLabel: 'See Inventory',
    ctaButtonHref: '/inventory/category/l40s',
    hasPreorder: true,
    hasOnDemand: true,
    hasReserve: true,
    hasCluster: true,
  },
  {
    name: 'NVIDIA RTX A6000',
    chipset: 'A6000',
    manufacturers: ['NVIDIA'],
    description:
      "The NVIDIA RTX A6000 combines performance, reliability, and rich feature sets tailored for professionals. Here, you'll find server configurations from dual A6000 setups perfect for graphic-intensive workloads to servers with multiple A6000 cards designed for complex computational tasks.",
    badgeList: ['Graphics', 'Professional Visualization', 'VR', 'Real Time Rendering', 'Complex CAD'],
    brandImages: [nvidiaLogo],
    startPrice: 0.5,
    priceFrequency: '/hr',
    ctaButtonLabel: 'See Inventory',
    ctaButtonHref: '/inventory/category/a6000',
    hasPreorder: true,
    hasOnDemand: true,
    hasReserve: true,
    hasCluster: false,
  },
  {
    name: 'NVIDIA RTX Pro 6000 Blackwell',
    chipset: 'RTX6000',
    manufacturers: ['NVIDIA'],
    description:
      'The NVIDIA RTX Pro 6000 Blackwell represents the next generation of professional GPU technology, built on the revolutionary Blackwell architecture. Designed for AI researchers, data scientists, and content creators demanding the highest performance, it delivers exceptional capabilities for generative AI, neural rendering, and complex simulations. With advanced memory bandwidth and compute efficiency, the RTX Pro 6000 Blackwell is engineered for professionals who need cutting-edge performance with enterprise-grade reliability.',
    badgeList: [
      'Blackwell Architecture',
      'Generative AI',
      'Neural Rendering',
      'Professional Visualization',
      'Data Science',
      'Advanced AI Training',
      'Real-Time Ray Tracing',
    ],
    brandImages: [nvidiaLogo],
    startPrice: 1.2,
    priceFrequency: '/hr',
    ctaButtonLabel: 'See Inventory',
    ctaButtonHref: '/inventory/category/rtx6000',
    hasPreorder: true,
    hasOnDemand: true,
    hasReserve: true,
    hasCluster: false,
  },
  {
    name: 'NVIDIA A10',
    chipset: 'A10',
    manufacturers: ['NVIDIA'],
    description:
      "The NVIDIA A10 GPU delivers the performance needed for designers, engineers, artists, and scientists to tackle today's challenges. This single-slot, 150W GPU, combined with NVIDIA vGPU software, accelerates various data center workloads, from graphics-rich VDI to AI, offering a secure, flexible, and scalable infrastructure.",
    badgeList: ['High Performance', 'AI Training and Inference', 'Versatile Workloads', 'Scalability', 'Security'],
    brandImages: [nvidiaLogo],
    startPrice: 0.65,
    priceFrequency: '/hr',
    ctaButtonLabel: 'See Inventory',
    ctaButtonHref: '/inventory/category/a10',
    hasPreorder: true,
    hasOnDemand: true,
    hasReserve: true,
    hasCluster: true,
  },
  {
    name: 'NVIDIA RTX 5090',
    chipset: '5090',
    manufacturers: ['NVIDIA'],
    description:
      'Introducing the NVIDIA GeForce RTX 5090, the pinnacle of consumer GPU performance powered by the revolutionary Blackwell architecture. Engineered for gamers, creators, and AI enthusiasts, the RTX 5090 delivers unprecedented computational power and efficiency. With 21,760 CUDA cores and 32GB of ultra-fast GDDR7 memory, it excels in demanding tasks from 8K gaming to AI-driven workflows.',
    badgeList: ['AI Workloads', '8K Video Editing', 'Real-Time Rendering', 'PCIe 5.0 Support', 'Thermal Efficiency'],
    brandImages: [nvidiaLogo],
    startPrice: 0.88,
    priceFrequency: '/hr',
    ctaButtonLabel: 'See Inventory',
    ctaButtonHref: '/inventory/category/5090',
    hasPreorder: true,
    hasOnDemand: true,
    hasReserve: true,
    hasCluster: false,
  },
  {
    name: 'NVIDIA RTX 4090',
    chipset: '4090',
    manufacturers: ['NVIDIA'],
    description:
      'The NVIDIA RTX 4090 server configurations are engineered for exceptional AI performance, offering powerful options from single 4090 servers ideal for AI inference to multi-GPU servers tailored for intensive AI training and deep learning tasks.',
    badgeList: [
      'Deep Learning',
      'AI Acceleration',
      'High Performance Computing',
      'Neural Network Training',
      'Real-Time AI Inference',
    ],
    brandImages: [nvidiaLogo],
    startPrice: 0.55,
    priceFrequency: '/hr',
    ctaButtonLabel: 'See Inventory',
    ctaButtonHref: '/inventory/category/4090',
    hasPreorder: true,
    hasOnDemand: true,
    hasReserve: true,
    hasCluster: true,
  },
  {
    name: 'NVIDIA RTX 3090',
    chipset: '3090',
    manufacturers: ['NVIDIA'],
    description:
      'The NVIDIA RTX 3090 server configurations are designed for outstanding performance in graphics-intensive and AI-driven applications, providing a range of options from single RTX 3090 servers suitable for high-end gaming and professional visualization to multi-GPU servers configured for advanced AI research and complex 3D rendering tasks.',
    badgeList: [
      'AI Research',
      'Deep Learning',
      'Computational Simulation',
      'Predictive Modeling',
      'Neural Network Training',
    ],
    brandImages: [nvidiaLogo],
    startPrice: 0.2,
    priceFrequency: '/hr',
    ctaButtonLabel: 'See Inventory',
    ctaButtonHref: '/inventory/category/3090',
    hasPreorder: true,
    hasOnDemand: true,
    hasReserve: true,
    hasCluster: true,
  },
  {
    name: 'NVIDIA RTX A4000',
    chipset: 'A4000',
    manufacturers: ['NVIDIA'],
    description:
      'The NVIDIA RTX A4000 is a powerful single-slot GPU for professionals, delivering real-time ray tracing, AI-enhanced compute, and high-performance graphics. Ideal for engineering next-gen products, designing future cityscapes, and creating immersive entertainment, it integrates seamlessly into various systems for unlimited productivity.',
    badgeList: [
      'Real-Time Ray Tracing',
      'AI-Accelerated Compute',
      'High-Performance Graphics',
      'Versatility',
      'Immersive Experience Creation',
    ],
    brandImages: [nvidiaLogo],
    startPrice: 0.2,
    priceFrequency: '/hr',
    ctaButtonLabel: 'See Inventory',
    ctaButtonHref: '/inventory/category/a4000',
    hasPreorder: true,
    hasOnDemand: true,
    hasReserve: true,
    hasCluster: true,
  },
  {
    name: 'CPU',
    chipset: 'CPU',
    manufacturers: ['Intel', 'AMD'],
    description:
      'For workloads where the CPU is king, this category lists servers focusing on high-performance CPUs from industry leaders like Intel and AMD. These range from efficient, balanced servers for web hosting to powerhouse configurations with multiple CPUs for server-side applications and large-scale data processing.',
    badgeList: ['Web Hosting', 'Enterprise Applications', 'Databases', 'Data Processing', 'Virtualization'],
    brandImages: [intelLogo, amdLogo],
    startPrice: 300,
    priceFrequency: 'month',
    ctaButtonLabel: 'See Inventory',
    ctaButtonHref: '/inventory/category/cpu',
    hasPreorder: true,
    hasOnDemand: true,
    hasReserve: true,
    hasCluster: false,
  },
];

export function matchesCategoryPrice(chipset: string, priceCategory: string): boolean {
  const normalizedChipset = chipset.toLowerCase();
  const normalizedPrice = priceCategory.toLowerCase();

  if (normalizedChipset === normalizedPrice) {
    return true;
  }

  const specialCases: Record<string, string[]> = {
    a10: ['a100', 'a4000', 'a5000', 'a6000'],
    h200: ['gh200'],
    b200: ['gb200'],
    b300: ['gb300'],
    gb200: ['b200'],
    gb300: ['b300'],
  };

  if (specialCases[normalizedChipset]) {
    const exclusions = specialCases[normalizedChipset];
    if (exclusions.some((exc) => normalizedPrice.includes(exc))) {
      return false;
    }
  }

  return normalizedPrice.includes(normalizedChipset);
}

interface CategoryData {
  chipset: string;
  startPrice: number;
  hasOnDemand: boolean;
  hasReserve: boolean;
  hasPreorder: boolean;
  [key: string]: unknown;
}

interface CategoryPrice {
  category: string;
  startPrice: number;
}

interface CategoryAvailabilityData {
  category: string;
  hasOnDemand: boolean;
  onDemandCount: number;
  hasReserve: boolean;
  reserveCount: number;
  hasPreorder: boolean;
  preorderCount: number;
}

export function mergeCategoryPrices<T extends CategoryData>(
  categories: T[],
  categoryPrices: CategoryPrice[],
  categoryAvailability: CategoryAvailabilityData[] = [],
): T[] {
  return categories.map((category) => {
    const dynamicPrice = categoryPrices.find((p) => matchesCategoryPrice(category.chipset, p.category));
    const availability = categoryAvailability.find((a) => matchesCategoryPrice(category.chipset, a.category));
    return {
      ...category,
      startPrice: dynamicPrice?.startPrice ?? category.startPrice,
      hasOnDemand: availability?.hasOnDemand ?? false,
      hasReserve: availability?.hasReserve ?? category.hasReserve,
      hasPreorder: availability?.hasPreorder ?? category.hasPreorder,
    };
  });
}
