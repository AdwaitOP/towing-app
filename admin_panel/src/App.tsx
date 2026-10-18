import React from 'react';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { AuthProvider } from '@/context/AuthContext';
import { ProtectedRoute } from '@/components/auth/ProtectedRoute';
import { AdminLayout } from '@/components/layout/AdminLayout';
import { LoginPage } from '@/pages/LoginPage';
import { DashboardShellPage } from '@/pages/DashboardShellPage';
import { PlaceholderModulePage } from '@/pages/PlaceholderModulePage';

export const App: React.FC = () => {
  return (
    <BrowserRouter>
      <AuthProvider>
        <Routes>
          {/* Public Route */}
          <Route path="/login" element={<LoginPage />} />

          {/* Protected Admin Routes */}
          <Route element={<ProtectedRoute />}>
            <Route element={<AdminLayout />}>
              <Route path="/" element={<DashboardShellPage />} />

              <Route
                path="/verification"
                element={
                  <PlaceholderModulePage
                    title="Driver Verification Queue"
                    milestone="Milestone 2"
                    description="Admin review queue for pending driver KYC applications with secure in-app document viewing and audited approval/rejection."
                    plannedFeatures={[
                      'Realtime pending KYC application queue filtered by verificationStatus == pending',
                      'Secure side-by-side viewing of Aadhaar ID, vehicle RC, and selfie camera captures',
                      'adminApproveDriver Cloud Function with server-side validation and admin_actions logging',
                      'adminRejectDriver Cloud Function requiring non-empty rejection reason and WhatsApp notification trigger',
                    ]}
                  />
                }
              />

              <Route
                path="/jobs"
                element={
                  <PlaceholderModulePage
                    title="Live Jobs Monitoring"
                    milestone="Milestone 2"
                    description="Real-time operations monitor displaying active tow requests, assignment telemetry, and dispatch cascade progress."
                    plannedFeatures={[
                      'Real-time Firestore snapshot listener on jobs collection',
                      'Filtering by job status (awaiting_payment, pending_offer, assigned, in_progress, completed, cancelled)',
                      'Search by customer phone number, vehicle type, and job identifier',
                      'Detailed dispatch run inspection, candidate offer history, and cancellation reason analysis',
                    ]}
                  />
                }
              />

              <Route
                path="/drivers"
                element={
                  <PlaceholderModulePage
                    title="Driver Management"
                    milestone="Milestone 3"
                    description="Roster management for registered towing drivers, duty status telemetry, wallet ledger audits, and cancellation forgiveness."
                    plannedFeatures={[
                      'Driver roster with duty status, truck capabilities, and verification badges',
                      'Prepaid wallet balance inspection and immutable wallet_entries ledger history',
                      'Audited adminForgiveCancellation Cloud Function crediting forfeited commission back to driver',
                      'Ban duration inspection and strictMode penalty status monitoring',
                    ]}
                  />
                }
              />

              <Route
                path="/config"
                element={
                  <PlaceholderModulePage
                    title="Config Editor"
                    milestone="Milestone 3"
                    description="Strongly typed administrative configuration editor for booking tiers, fare formula parameters, and cancellation policies."
                    plannedFeatures={[
                      'Booking tiers editor (tier 1/2 limits, booking fees, driver commissions, and overage rates)',
                      'Informational fare formula editor (base rates, per-km rates, night/highway surge multipliers)',
                      'Cancellation policy editor with strict ramp percentage validation (Asia/Kolkata timezone)',
                      'adminUpdatePricingConfig Cloud Function with strict server-side schema assertion and audit logging',
                    ]}
                  />
                }
              />

              <Route
                path="/phone-booking"
                element={
                  <PlaceholderModulePage
                    title="Phone Booking Pipeline"
                    milestone="Milestone 4"
                    description="Inbound phone call dispatch interface leveraging the shared createJobAndQuote backend with authenticated admin attribution."
                    plannedFeatures={[
                      'Phone booking intake form (customer phone, pickup coordinates, destination coordinates, truck category)',
                      'Shared createJobAndQuote integration with channel: phone and createdByAdmin attribution',
                      'Razorpay booking-fee payment link generation with automated WhatsApp delivery to customer',
                      'adminCreatePhoneBooking Cloud Function with full admin_actions audit trail',
                    ]}
                  />
                }
              />
            </Route>
          </Route>

          {/* Catch-all */}
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </AuthProvider>
    </BrowserRouter>
  );
};
