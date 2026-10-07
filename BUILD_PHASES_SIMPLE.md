# Simple Build Phases — Towing Dispatch Project

This is a simplified version of the technical build plan, meant for non-technical discussion.

## Overall Order

Phases **1 → 2 → 3 → 4** must be completed in order.

After that, **Phase 5 (Driver App)** and **Phase 6 (Admin Panel)** can be built at the same time.

**Phase 7** is the final full-system check.

---

## Phase 1 — Build the Foundation

Set up the main database, security, driver documents, pricing settings, and basic backend structure.

**Goal:** Create a safe and organised base for everything else.

---

## Phase 2 — Build Fare Calculation

Create the system that automatically calculates the towing price using distance, vehicle type, time, and our pricing rules.

**Goal:** Make sure the app calculates fares correctly and can be adjusted later without rebuilding the app.

---

## Phase 3 — Customer Booking, Payment & Invoice

Build the customer booking flow through WhatsApp.

This includes:
- Taking pickup and destination details
- Showing the customer the quote
- Collecting the booking fee through Razorpay
- Sending driver OTPs through WhatsApp
- Creating GST invoices for our booking fee

**Goal:** Allow a customer to create and pay for a booking.

---

## Phase 4 — Find and Assign a Driver

Build the main dispatch system.

It will:
- Find nearby available and approved drivers
- Offer the job to drivers one by one
- Prevent two drivers from accepting the same job
- Handle cancellations, refunds, penalties, and temporary bans
- Protect the system from excessive API usage or unexpected costs

**Goal:** Reliably connect every paid customer booking to the right driver.

**Important:** This is the most sensitive backend phase because it controls job assignment and money-related rules.

---

## Phase 5 — Driver App

Build the mobile app used by towing drivers.

Main features:
- Login using WhatsApp OTP
- Driver profile and document verification
- Online/offline status
- Receive job offers
- Accept, complete, or cancel jobs
- Wallet and commission information
- Location sharing while working
- Ban and cancellation-penalty information

**Goal:** Give drivers everything they need to receive and complete towing jobs.

---

## Phase 6 — Admin Panel

Build the control panel for us to manage the business.

Main features:
- Approve or reject drivers
- See active jobs
- Manage drivers
- Change pricing and business settings
- Create bookings manually for customers who call us
- Keep a record of important admin actions

**Goal:** Give us full control of day-to-day operations without editing the backend manually.

---

## Phase 7 — Final Testing & Audit

Test the complete system from start to finish.

Check:
- Customer booking
- Payments
- Driver assignment
- Driver app
- Admin panel
- Cancellations and refunds
- Security
- Pricing
- Invoices
- Edge cases and failures

Fix anything that does not work correctly before launch.

**Goal:** Make sure the complete system is reliable and ready for real customers and drivers.

---

## In One Line

**Foundation → Fare Calculation → Customer Booking & Payment → Driver Dispatch → Driver App + Admin Panel → Final Testing**
