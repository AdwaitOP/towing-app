import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { VerificationDecisionDialog } from '../VerificationDecisionDialog';
import type { DriverProfile } from '@/types/operations';

describe('VerificationDecisionDialog (O1, O2, F03, F04)', () => {
  const mockDriver: DriverProfile = {
    uid: 'driver-test-123',
    name: 'Rajesh Kumar',
    phone: '+919876543210',
    vehicleNumber: 'MH 12 AB 1234',
    truckType: 'flatbed',
    verificationStatus: 'pending',
    canFlatbed: false,
    canPulling: false,
    isOnDuty: false,
    createdAt: { seconds: 1700000000, nanoseconds: 0 },
    updatedAt: { seconds: 1700000000, nanoseconds: 0 },
  };

  it('renders approval dialog and enforces explicit capabilities (O1)', () => {
    const onConfirmApprove = vi.fn().mockResolvedValue(undefined);
    const onConfirmReject = vi.fn().mockResolvedValue(undefined);
    const onClose = vi.fn();

    render(
      <VerificationDecisionDialog
        mode="approve"
        driver={mockDriver}
        isOpen={true}
        isSubmitting={false}
        error={null}
        onConfirmApprove={onConfirmApprove}
        onConfirmReject={onConfirmReject}
        onClose={onClose}
      />
    );

    // Initial state: neither is checked, confirm button is disabled
    const flatbedCheckbox = screen.getByLabelText(/flatbed towing/i) as HTMLInputElement;
    const pullingCheckbox = screen.getByLabelText(/pulling \/ tochan towing/i) as HTMLInputElement;
    const approveBtn = screen.getByRole('button', { name: /confirm approval/i });

    expect(flatbedCheckbox.checked).toBe(false);
    expect(pullingCheckbox.checked).toBe(false);
    expect(approveBtn).toBeDisabled();

    // Check pulling -> enabled
    fireEvent.click(pullingCheckbox);
    expect(pullingCheckbox.checked).toBe(true);
    expect(approveBtn).not.toBeDisabled();

    // Submit approval
    fireEvent.click(approveBtn);
    expect(onConfirmApprove).toHaveBeenCalledWith({
      canFlatbed: false,
      canPulling: true,
      requestId: expect.any(String),
    });
  });

  it('renders rejection dialog and enforces reason length and character restrictions (O2)', () => {
    const onConfirmApprove = vi.fn().mockResolvedValue(undefined);
    const onConfirmReject = vi.fn().mockResolvedValue(undefined);
    const onClose = vi.fn();

    render(
      <VerificationDecisionDialog
        mode="reject"
        driver={mockDriver}
        isOpen={true}
        isSubmitting={false}
        error={null}
        onConfirmApprove={onConfirmApprove}
        onConfirmReject={onConfirmReject}
        onClose={onClose}
      />
    );

    const textarea = screen.getByPlaceholderText(/uploaded vehicle rc photo is blurred/i) as HTMLTextAreaElement;
    const rejectBtn = screen.getByRole('button', { name: /confirm rejection/i });

    // Initial state: blank reason -> disabled
    expect(rejectBtn).toBeDisabled();

    // Less than 10 characters -> disabled
    fireEvent.change(textarea, { target: { value: 'Too short' } });
    expect(rejectBtn).toBeDisabled();

    // Valid 10+ characters -> enabled
    fireEvent.change(textarea, {
      target: { value: 'RC copy is blurry and unreadable.' },
    });
    expect(rejectBtn).not.toBeDisabled();

    // Submitting rejection passes normalized trimmed plain text
    fireEvent.click(rejectBtn);
    expect(onConfirmReject).toHaveBeenCalledWith({
      reason: 'RC copy is blurry and unreadable.',
      requestId: expect.any(String),
    });
  });
});
