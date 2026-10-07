import 'dart:math' as math;
import 'package:flutter/material.dart';

import '../../../core/models/driver_profile.dart';
import '../../../core/models/job_offer.dart';
import '../../../core/services/offer_service.dart';
import '../../../l10n/app_localizations.dart';
import '../../../theme/app_colors.dart';
import '../../../theme/app_typography.dart';

/// Phase 5 Batch 2 Cancellation Preview Dialog.
///
/// Provides a truthful, non-authoritative client preview of potential cancellation
/// penalties based on the offer's `cancellationPolicySnapshot` and the driver's
/// `monthlyCancelCount`.
///
/// INVARIANTS:
/// 1. The client preview is explicitly labelled non-authoritative. Backend server
///    transaction is the sole financial and ban authority.
/// 2. RequestId semantics: one requestId is generated per logical cancellation attempt.
///    Retries following timeout or network uncertainty reuse the identical requestId.
/// 3. Single-flight guard: buttons are synchronously disabled while request is in flight.
/// 4. Customer cancellation overlap: if backend returns `customer_cancellation_in_progress`,
///    it is presented truthfully as non-penalizing.
class CancellationPreviewDialog extends StatefulWidget {
  final JobOffer offer;
  final DriverProfile profile;
  final OfferService offerService;
  final void Function(CancelJobResult result) onCancelled;
  final DateTime Function()? clock;

  const CancellationPreviewDialog({
    super.key,
    required this.offer,
    required this.profile,
    required this.offerService,
    required this.onCancelled,
    this.clock,
  });

  static Future<void> show({
    required BuildContext context,
    required JobOffer offer,
    required DriverProfile profile,
    required OfferService offerService,
    required void Function(CancelJobResult result) onCancelled,
    DateTime Function()? clock,
  }) {
    return showDialog<void>(
      context: context,
      barrierDismissible: false,
      builder: (dialogContext) => CancellationPreviewDialog(
        offer: offer,
        profile: profile,
        offerService: offerService,
        onCancelled: onCancelled,
        clock: clock,
      ),
    );
  }

  @override
  State<CancellationPreviewDialog> createState() => _CancellationPreviewDialogState();
}

class _CancellationPreviewDialogState extends State<CancellationPreviewDialog> {
  bool _isCancelling = false;
  String? _errorMessage;
  String? _currentRequestId;

  DateTime get _now => widget.clock != null ? widget.clock!() : DateTime.now();

  String _currentIstMonth(DateTime dt) {
    // Convert to IST (UTC + 5:30)
    final ist = dt.toUtc().add(const Duration(hours: 5, minutes: 30));
    final year = ist.year.toString().padLeft(4, '0');
    final month = ist.month.toString().padLeft(2, '0');
    return '$year-$month';
  }

  /// Calculates a non-authoritative penalty preview matching backend policy rules.
  _PreviewCalculation _calculatePreview() {
    final policy = widget.offer.cancellationPolicySnapshot;
    final commissionPaise = widget.offer.driverCommissionPaise;

    final int freePerMonth = (policy?['freeCancellationsPerMonth'] ?? policy?['free_cancellations_per_month'] ?? 1) as int;
    final int banThreshold = (policy?['banThresholdCount'] ?? policy?['ban_threshold_count'] ?? 3) as int;
    final dynamic rawRamp = policy?['forfeitPctByCount'] ?? policy?['forfeit_pct_by_count'];
    final Map<String, dynamic> ramp = rawRamp is Map<String, dynamic> ? rawRamp : const {'2': 50};

    final currentMonth = _currentIstMonth(_now);
    final rawMonthly = widget.profile.monthlyCancelCount;

    int countBefore = 0;
    bool strictModeBefore = false;

    if (rawMonthly != null && rawMonthly.month == currentMonth) {
      countBefore = rawMonthly.count;
      strictModeBefore = widget.profile.strictMode;
    }

    final countAfter = countBefore + 1;
    int forfeitPct = 0;
    bool willBan = false;

    if (strictModeBefore) {
      forfeitPct = 100;
      willBan = true;
    } else if (countAfter <= freePerMonth) {
      forfeitPct = 0;
      willBan = false;
    } else if (countAfter < banThreshold) {
      final key = countAfter.toString();
      final rampVal = ramp[key];
      forfeitPct = rampVal is int ? rampVal : 50;
      willBan = false;
    } else {
      forfeitPct = 100;
      willBan = true;
    }

    // Half-up integer paise calculation
    final forfeiturePaise = math.min(commissionPaise, ((commissionPaise * forfeitPct + 50) ~/ 100));
    final refundPaise = math.max(0, commissionPaise - forfeiturePaise);
    final freeRemaining = math.max(0, freePerMonth - countBefore);

    return _PreviewCalculation(
      freeRemaining: freeRemaining,
      forfeitPct: forfeitPct,
      estimatedForfeiturePaise: forfeiturePaise,
      estimatedRefundPaise: refundPaise,
      willTriggerBan: willBan,
      isStrictMode: strictModeBefore,
    );
  }

  Future<void> _handleConfirmCancel() async {
    if (_isCancelling) return;

    setState(() {
      _isCancelling = true;
      _errorMessage = null;
      // Logical user operation: retain requestId across retries
      _currentRequestId ??= 'req_cancel_${DateTime.now().millisecondsSinceEpoch}_${widget.offer.id.substring(0, math.min(8, widget.offer.id.length))}';
    });

    try {
      final result = await widget.offerService.cancelJob(
        jobId: widget.offer.jobId,
        offerId: widget.offer.id,
        requestId: _currentRequestId!,
      );

      if (!mounted) return;

      if (result.isCustomerCancelled) {
        // Customer overlap: non-penalizing
        Navigator.of(context).pop();
        widget.onCancelled(result);
      } else if (result.cancelled) {
        Navigator.of(context).pop();
        widget.onCancelled(result);
      } else {
        setState(() {
          _isCancelling = false;
          _errorMessage = result.reason ?? 'Failed to cancel job';
        });
      }
    } catch (e) {
      if (!mounted) return;
      setState(() {
        _isCancelling = false;
        if (e is OfferActionException) {
          _errorMessage = e.message;
        } else {
          _errorMessage = 'Network error. Tap retry to submit with same request ID.';
        }
      });
    }
  }

  @override
  Widget build(BuildContext context) {
    final l10n = AppLocalizations.of(context)!;
    final preview = _calculatePreview();

    return AlertDialog(
      title: Row(
        children: [
          const Icon(Icons.warning_amber_rounded, color: AppColors.error, size: 28.0),
          const SizedBox(width: 8.0),
          Expanded(
            child: Text(
              l10n.cancellationPreviewTitle,
              style: AppTypography.titleLarge.copyWith(color: AppColors.error),
            ),
          ),
        ],
      ),
      content: SingleChildScrollView(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            // Non-authoritative disclaimer notice
            Container(
              padding: const EdgeInsets.all(10.0),
              decoration: BoxDecoration(
                color: AppColors.surfaceVariant,
                borderRadius: BorderRadius.circular(8.0),
                border: Border.all(color: AppColors.border),
              ),
              child: Row(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  const Icon(Icons.info_outline, size: 16.0, color: AppColors.textSecondary),
                  const SizedBox(width: 8.0),
                  Expanded(
                    child: Text(
                      l10n.cancellationPreviewNotice,
                      style: AppTypography.bodyMedium.copyWith(fontSize: 11.0, color: AppColors.textSecondary),
                    ),
                  ),
                ],
              ),
            ),
            const SizedBox(height: 16.0),

            // Free cancellations remaining
            Row(
              mainAxisAlignment: MainAxisAlignment.spaceBetween,
              children: [
                Text(
                  l10n.freeCancellationsRemaining(preview.freeRemaining.toString()),
                  style: AppTypography.bodyMedium.copyWith(fontWeight: FontWeight.w500),
                ),
              ],
            ),
            const Divider(height: 20.0),

            // Estimated Forfeiture
            Row(
              mainAxisAlignment: MainAxisAlignment.spaceBetween,
              children: [
                Text(l10n.estimatedDeduction((preview.estimatedForfeiturePaise / 100).toStringAsFixed(2)),
                    style: AppTypography.bodyMedium.copyWith(
                      color: preview.estimatedForfeiturePaise > 0 ? AppColors.error : AppColors.textSecondary,
                      fontWeight: FontWeight.bold,
                    )),
              ],
            ),
            const SizedBox(height: 8.0),

            // Estimated Refund
            Row(
              mainAxisAlignment: MainAxisAlignment.spaceBetween,
              children: [
                Text(l10n.estimatedRefund((preview.estimatedRefundPaise / 100).toStringAsFixed(2)),
                    style: AppTypography.bodyMedium.copyWith(
                      color: AppColors.success,
                      fontWeight: FontWeight.bold,
                    )),
              ],
            ),
            const SizedBox(height: 12.0),

            // Ban warning banner if applicable
            if (preview.willTriggerBan || preview.isStrictMode) ...[
              Container(
                padding: const EdgeInsets.all(10.0),
                decoration: BoxDecoration(
                  color: AppColors.error.withValues(alpha: 0.12),
                  borderRadius: BorderRadius.circular(8.0),
                  border: Border.all(color: AppColors.error),
                ),
                child: Row(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    const Icon(Icons.block, size: 18.0, color: AppColors.error),
                    const SizedBox(width: 8.0),
                    Expanded(
                      child: Text(
                        preview.isStrictMode ? l10n.strictModeWarning : l10n.banWarning,
                        style: AppTypography.bodyMedium.copyWith(
                          fontSize: 12.0,
                          color: AppColors.error,
                          fontWeight: FontWeight.w600,
                        ),
                      ),
                    ),
                  ],
                ),
              ),
              const SizedBox(height: 12.0),
            ],

            // In-flight error message
            if (_errorMessage != null) ...[
              Container(
                padding: const EdgeInsets.all(10.0),
                decoration: BoxDecoration(
                  color: AppColors.error.withValues(alpha: 0.1),
                  borderRadius: BorderRadius.circular(8.0),
                ),
                child: Text(
                  _errorMessage!,
                  style: AppTypography.bodyMedium.copyWith(color: AppColors.error, fontSize: 12.0),
                ),
              ),
              const SizedBox(height: 12.0),
            ],
          ],
        ),
      ),
      actions: [
        Semantics(
          button: true,
          label: l10n.keepJob,
          child: TextButton(
            key: const ValueKey('keep_job_button'),
            style: TextButton.styleFrom(
              minimumSize: const Size(120.0, 56.0),
            ),
            onPressed: _isCancelling ? null : () => Navigator.of(context).pop(),
            child: Text(l10n.keepJob),
          ),
        ),
        Semantics(
          button: true,
          label: l10n.confirmCancellation,
          child: FilledButton(
            key: const ValueKey('confirm_cancellation_button'),
            style: FilledButton.styleFrom(
              backgroundColor: AppColors.error,
              foregroundColor: Colors.white,
              minimumSize: const Size(160.0, 56.0),
            ),
            onPressed: _isCancelling ? null : _handleConfirmCancel,
            child: _isCancelling
                ? const SizedBox(
                    width: 18.0,
                    height: 18.0,
                    child: CircularProgressIndicator(strokeWidth: 2.0, color: Colors.white),
                  )
                : Text(_errorMessage != null ? l10n.retryCancel : l10n.confirmCancellation),
          ),
        ),
      ],
    );
  }
}

class _PreviewCalculation {
  final int freeRemaining;
  final int forfeitPct;
  final int estimatedForfeiturePaise;
  final int estimatedRefundPaise;
  final bool willTriggerBan;
  final bool isStrictMode;

  const _PreviewCalculation({
    required this.freeRemaining,
    required this.forfeitPct,
    required this.estimatedForfeiturePaise,
    required this.estimatedRefundPaise,
    required this.willTriggerBan,
    required this.isStrictMode,
  });
}
