/**
 * The fixed choices on the public forms. The values are what the API stores
 * and expects; the labels are suggested wording for the app and website.
 * GET /form-options returns these lists, so the forms never get out of step.
 */

/** Must match donation_pledge_category_check in the database. */
export const DONATION_CATEGORY_VALUES = [
  'Goods',
  'Monetary',
  'School supplies',
  'Food and essentials',
] as const;
export type DonationCategory = (typeof DONATION_CATEGORY_VALUES)[number];

/**
 * What people can ask for help with: the organisation's activities and the
 * stock it hands out. Stored as text, so this list can change without a
 * database change.
 */
export const ASSISTANCE_REQUEST_TYPE_VALUES = [
  'Clothing',
  'Blankets',
  'Sanitary products',
  'Food',
  'School supplies',
  'Other',
] as const;
export type AssistanceRequestType = (typeof ASSISTANCE_REQUEST_TYPE_VALUES)[number];

/** Must match enquiry_enquiry_type_check in the database. */
export const ENQUIRY_TYPE_VALUES = ['Donor', 'Partner'] as const;
export type EnquiryType = (typeof ENQUIRY_TYPE_VALUES)[number];

const DONATION_CATEGORY_LABELS: Record<DonationCategory, string> = {
  Goods: 'Goods (clothing, blankets)',
  Monetary: 'Monetary donation',
  'School supplies': 'School supplies',
  'Food and essentials': 'Food and essentials',
};

const ASSISTANCE_REQUEST_TYPE_LABELS: Record<AssistanceRequestType, string> = {
  Clothing: 'Clothing',
  Blankets: 'Blankets',
  'Sanitary products': 'Sanitary pads and hygiene products',
  Food: 'Food parcels',
  'School supplies': 'School supplies',
  Other: 'Something else',
};

const ENQUIRY_TYPE_LABELS: Record<EnquiryType, string> = {
  Donor: 'I would like to donate',
  Partner: 'My organisation would like to partner with you',
};

const withLabels = <Value extends string>(
  values: readonly Value[],
  labels: Record<Value, string>,
) => values.map((value) => ({ value, label: labels[value] }));

/** GET /form-options */
export const FORM_OPTIONS = {
  donationCategories: withLabels(DONATION_CATEGORY_VALUES, DONATION_CATEGORY_LABELS),
  assistanceRequestTypes: withLabels(
    ASSISTANCE_REQUEST_TYPE_VALUES,
    ASSISTANCE_REQUEST_TYPE_LABELS,
  ),
  enquiryTypes: withLabels(ENQUIRY_TYPE_VALUES, ENQUIRY_TYPE_LABELS),
};
