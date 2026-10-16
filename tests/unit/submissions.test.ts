import type { Request, Response } from 'express';
import { describe, expect, it } from 'vitest';
import { honeypot } from '../../src/middleware/honeypot';
import {
  ASSISTANCE_REQUEST_TYPE_VALUES,
  DONATION_CATEGORY_VALUES,
  FORM_OPTIONS,
} from '../../src/modules/submissions/submissions.options';
import {
  assistanceRequestSchema,
  donationPledgeSchema,
  enquirySchema,
  volunteerApplicationSchema,
} from '../../src/modules/submissions/submissions.schemas';
import { pretendReceipt } from '../../src/modules/submissions/submissions.service';

const firstMessages = (result: {
  error?: { issues: Array<{ path: PropertyKey[]; message: string }> };
}) => {
  const messages: Record<string, string> = {};
  for (const issue of result.error?.issues ?? []) {
    messages[issue.path.join('.') || 'request'] ??= issue.message;
  }
  return messages;
};

const volunteer = {
  initiativeId: 12,
  taskId: 3,
  fullName: 'Sipho Dlamini',
  phone: '072 345 6789',
  email: 'Sipho.Dlamini@Example.com',
  contribution: 'I can sort by size and prepare bundles.',
  availability: '24 Oct, 10:00–14:00',
  consent: true,
};

describe('public form rules', () => {
  it('cleans up what people type', () => {
    expect(volunteerApplicationSchema.parse({ ...volunteer, initiativeId: '12' })).toEqual({
      ...volunteer,
      phone: '+27723456789',
      email: 'sipho.dlamini@example.com',
    });
  });

  it('treats empty optional fields as not given', () => {
    const parsed = volunteerApplicationSchema.parse({ ...volunteer, email: '', taskId: null });
    expect(parsed.email).toBeUndefined();
    expect(parsed.taskId).toBeUndefined();
    const enquiry = enquirySchema.parse({
      fullName: 'Ayanda Zulu',
      email: 'ayanda@example.org',
      phone: '  ',
      enquiryType: 'Donor',
      message: 'I would like to donate school shoes.',
      consent: true,
    });
    expect(enquiry.phone).toBeUndefined();
  });

  it('needs the consent box ticked on every form', () => {
    const message = 'Please tick the box to agree before sending.';
    for (const schema of [
      volunteerApplicationSchema,
      donationPledgeSchema,
      assistanceRequestSchema,
      enquirySchema,
    ]) {
      expect(firstMessages(schema.safeParse({ consent: false })).consent).toBe(message);
      expect(firstMessages(schema.safeParse({})).consent).toBe(message);
    }
  });

  it('explains each problem under its field', () => {
    expect(
      firstMessages(
        volunteerApplicationSchema.safeParse({
          initiativeId: 'abc',
          fullName: 'S1pho',
          phone: '12345',
          contribution: 'short',
          consent: true,
        }),
      ),
    ).toEqual({
      initiativeId: 'Please choose an event.',
      fullName: 'Please enter your name using letters only.',
      phone: 'Please enter a South African number, for example 071 234 5678.',
      contribution: 'Please tell us a little more (at least 10 characters).',
      availability: 'Please say when you are available.',
    });
  });

  it('reads pledge amounts in rands, from R0 to R1,000,000', () => {
    const pledge = {
      fullName: 'Naledi Mokoena',
      email: 'naledi@example.com',
      phone: '+27 71 234 5678',
      category: 'Goods',
      description: '12 clean blankets for the clothing drive.',
      consent: true,
    };
    const parse = (estimatedValue: unknown) =>
      donationPledgeSchema.parse({ ...pledge, estimatedValue }).estimatedValue;
    expect(parse('R1200.50')).toBe(120_050);
    expect(parse(0)).toBe(0);
    expect(parse('')).toBeUndefined();
    expect(
      firstMessages(donationPledgeSchema.safeParse({ ...pledge, estimatedValue: 1_000_001 }))
        .estimatedValue,
    ).toMatch(/up to R1/);
    expect(
      firstMessages(donationPledgeSchema.safeParse({ ...pledge, category: 'Cash' })).category,
    ).toBe('Please choose one of the options.');
  });

  it('keeps messages between 10 and 1,000 characters', () => {
    const request = {
      fullName: 'Thandi Nkosi',
      phone: '082 555 0101',
      requestType: 'Blankets',
      consent: true,
    };
    const check = (description: string) =>
      firstMessages(assistanceRequestSchema.safeParse({ ...request, description }));
    expect(check(' ')).toEqual({ description: 'Please describe the help you need.' });
    expect(check('x'.repeat(1001))).toEqual({
      description: 'Please keep this under 1,000 characters.',
    });
  });

  it('offers the same choices the rules accept', () => {
    expect(FORM_OPTIONS.donationCategories.map((option) => option.value)).toEqual([
      ...DONATION_CATEGORY_VALUES,
    ]);
    expect(FORM_OPTIONS.assistanceRequestTypes.map((option) => option.value)).toEqual([
      ...ASSISTANCE_REQUEST_TYPE_VALUES,
    ]);
    expect(FORM_OPTIONS.enquiryTypes.map((option) => option.value)).toEqual(['Donor', 'Partner']);
  });
});

describe('spam trap', () => {
  function run(body: unknown) {
    const reply = { status: 0, body: undefined as unknown, passedOn: false };
    const res = {
      status(code: number) {
        reply.status = code;
        return res;
      },
      json(value: unknown) {
        reply.body = value;
        return res;
      },
    };
    honeypot(() => pretendReceipt('VOL'))(
      { body, originalUrl: '/api/v1/volunteer-applications' } as Request,
      res as unknown as Response,
      () => {
        reply.passedOn = true;
      },
    );
    return reply;
  }

  it('lets people through: the hidden field is empty or missing', () => {
    expect(run({ website: '' }).passedOn).toBe(true);
    expect(run({ website: '  ' }).passedOn).toBe(true);
    expect(run({ fullName: 'Sipho' }).passedOn).toBe(true);
    expect(run(undefined).passedOn).toBe(true);
  });

  it('gives bots a normal-looking success and stops there', () => {
    const reply = run({ website: 'https://spam.example' });
    expect(reply.passedOn).toBe(false);
    expect(reply.status).toBe(201);
    expect(reply.body).toMatchObject({
      success: true,
      data: { referenceNumber: expect.stringMatching(/^VOL-[A-Z2-9]{6}$/), status: 'Submitted' },
    });
    expect(pretendReceipt(null).referenceNumber).toBeNull();
    expect(pretendReceipt('PLG').status).toBe('Pending');
  });
});
