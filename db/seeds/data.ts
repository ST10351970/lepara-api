/**
 * Seed data. Reference data is needed in every environment, including the
 * live one. Sample data exists only so the frontend can be demonstrated
 * before the admin screens exist; never load it into the live database.
 */

/** Task 1, Section 3.3: the organisation's activities. */
export const INITIATIVE_TYPES = [
  { name: 'Garment donations', description: 'Collecting and handing out clothing and blankets.' },
  { name: 'Pad drives', description: 'Collecting and distributing sanitary products.' },
  { name: 'School talks', description: 'Talks and workshops at schools.' },
  { name: 'Winter feeding', description: 'Feeding people in need during winter.' },
  {
    name: 'Motivational and community engagement',
    description: 'Motivational events and community days.',
  },
] as const;

export const STOCK_ITEMS = [
  { name: 'Blankets', category: 'Bedding', unit: 'blanket', reorderLevel: 10 },
  { name: 'Clothing bundles', category: 'Clothing', unit: 'bundle', reorderLevel: 10 },
  { name: 'Sanitary pads', category: 'Hygiene', unit: 'pack', reorderLevel: 20 },
  { name: 'Food parcels', category: 'Food', unit: 'parcel', reorderLevel: 5 },
  { name: 'School supply packs', category: 'Education', unit: 'pack', reorderLevel: 5 },
] as const;

export const PRODUCT_CATEGORIES = ['T-shirts', 'Hoodies', 'Accessories'] as const;

// --- Sample data: from the mobile app's placeholder screens -----------------

export const SAMPLE_INITIATIVES = [
  {
    type: 'Garment donations',
    title: 'Community clothing drive',
    summary: 'Donate clothing or volunteer to sort and prepare bundles.',
    description:
      'Help sort clothing, prepare donation bundles and welcome neighbours. Bring clean, wearable clothing and blankets, or contribute your time.',
    location: 'Orlando Community Hall, Soweto',
    startDate: '2026-10-24',
    endDate: '2026-10-24',
    startTime: '10:00',
    endTime: '14:00',
    donationNeeds: 'Clothing, blankets',
    volunteersRequired: true,
    status: 'Published',
    tasks: [
      'Clothing sorting',
      'Packing clothing bundles',
      'Event setup and registration',
      'Distribution support',
    ],
  },
  {
    type: 'School talks',
    title: 'Youth skills workshop',
    summary: 'A practical skills morning for young people.',
    description:
      'Sample event for demonstrations. Replace with the real details before going live.',
    location: null,
    startDate: '2026-11-07',
    endDate: '2026-11-07',
    startTime: null,
    endTime: null,
    donationNeeds: 'School supplies',
    volunteersRequired: true,
    status: 'Published',
    tasks: ['Event setup and registration'],
  },
  {
    type: 'Winter feeding',
    title: 'Winter support collection',
    summary: 'Collecting food, blankets and warm clothing for winter.',
    description:
      'Sample event for demonstrations. Replace with the real details before going live.',
    location: null,
    startDate: '2026-11-14',
    endDate: '2026-11-14',
    startTime: null,
    endTime: null,
    donationNeeds: 'Food and essentials, blankets',
    volunteersRequired: true,
    status: 'Published',
    tasks: ['Event setup and registration', 'Distribution support'],
  },
  {
    type: 'Motivational and community engagement',
    title: 'Spring community day',
    summary: 'A shared morning in the community garden.',
    description:
      'Neighbours joined to clear plots and sow seeds for the coming season in the community garden.',
    location: 'Mofolo Community Garden, Soweto',
    startDate: '2026-09-26',
    endDate: '2026-09-26',
    startTime: '09:00',
    endTime: '13:00',
    donationNeeds: null,
    volunteersRequired: false,
    status: 'Closed',
    tasks: [],
  },
] as const;

export const SAMPLE_PRODUCTS = [
  {
    category: 'T-shirts',
    name: 'Community tee',
    colour: 'White',
    material: 'Cotton',
    priceCents: 25_000,
    skuPrefix: 'TEE-WHT',
    sizes: ['XS', 'S', 'M', 'L', 'XL', 'XXL'],
  },
  {
    category: 'Hoodies',
    name: 'Everyday hoodie',
    colour: 'Black',
    material: 'Cotton blend',
    priceCents: 55_000,
    skuPrefix: 'HOOD-BLK',
    sizes: ['S', 'M', 'L', 'XL', 'XXL'],
  },
  {
    category: 'Accessories',
    name: 'Together tote',
    colour: 'Natural',
    material: 'Canvas',
    priceCents: 18_000,
    skuPrefix: 'TOTE-NAT',
    sizes: ['One size'],
  },
] as const;

export const SAMPLE_STOCK_PER_SIZE = 10;
