import 'dart:async';
import 'package:flutter/material.dart';

import '../../../core/models/job_offer.dart';
import '../../../core/services/offer_service.dart';
import '../../../l10n/app_localizations.dart';
import '../../../theme/app_colors.dart';
import '../../../theme/app_typography.dart';

/// Modal/card presenting an incoming dispatch job offer to an on-duty driver.
///
/// Features:
/// - Real-time countdown timer derived strictly from server `expiresAt`.
/// - Single-flight button locking against double-tap races.
/// - Logical-operation `requestId` preservation across network retries.
/// - Truthful insufficient-wallet error display without fabricating local offer resolution.
class IncomingOfferSheet extends StatefulWidget {
  final JobOffer offer;
  final OfferService offerService;
  final VoidCallback? onResolved;
  final DateTime Function()? clock;
  final String Function()? requestIdGenerator;

  const IncomingOfferSheet({
    super.key,
    required this.offer,
    required this.offerService,
    this.onResolved,
    this.clock,
    this.requestIdGenerator,
  });

  @override
  State<IncomingOfferSheet> createState() => _IncomingOfferSheetState();
}

class _IncomingOfferSheetState extends State<IncomingOfferSheet> {
  Timer? _timer;
  late Duration _remaining;
  bool _isExpired = false;

  bool _isProcessing = false;
  String? _errorMessage;
  bool _isInsufficientBalance = false;

  // Stored requestId for retrying the SAME logical accept/decline action on network uncertainty
  String? _activeAcceptRequestId;
  String? _activeDeclineRequestId;

  DateTime _now() => widget.clock != null ? widget.clock!() : DateTime.now();

  @override
  void initState() {
    super.initState();
    _updateTimerState();
    _timer = Timer.periodic(const Duration(seconds: 1), (_) {
      if (mounted) {
        setState(() {
          _updateTimerState();
        });
      }
    });
  }

  void _updateTimerState() {
    final now = _now();
    _remaining = widget.offer.remainingDuration(now);
    _isExpired = widget.offer.isExpired(now) || _remaining == Duration.zero;
    if (_isExpired) {
      _timer?.cancel();
    }
  }

  @override
  void didUpdateWidget(IncomingOfferSheet oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (widget.offer.id != oldWidget.offer.id ||
        widget.offer.expiresAt != oldWidget.offer.expiresAt) {
      _updateTimerState();
      _activeAcceptRequestId = null;
      _activeDeclineRequestId = null;
      _errorMessage = null;
      _isInsufficientBalance = false;
    }
  }

  @override
  void dispose() {
    _timer?.cancel();
    super.dispose();
  }

  String _generateRequestId() {
    if (widget.requestIdGenerator != null) {
      return widget.requestIdGenerator!();
    }
    return '${widget.offer.id}_${DateTime.now().microsecondsSinceEpoch}';
  }

  Future<void> _handleAccept() async {
    if (_isProcessing || _isExpired) return;

    // Reuse existing requestId if retrying an uncertain attempt; otherwise generate fresh ID
    final requestId = _activeAcceptRequestId ??= _generateRequestId();

    setState(() {
      _isProcessing = true;
      _errorMessage = null;
      _isInsufficientBalance = false;
    });

    try {
      final result = await widget.offerService.acceptOffer(
        jobId: widget.offer.jobId,
        offerId: widget.offer.id,
        requestId: requestId,
      );

      if (mounted && result.accepted) {
        // Successful acceptance: cleared requestId and notify resolution
        _activeAcceptRequestId = null;
        widget.onResolved?.call();
      }
    } on OfferActionException catch (e) {
      if (!mounted) return;
      setState(() {
        if (e.isInsufficientBalance) {
          _isInsufficientBalance = true;
          _errorMessage = e.message;
          // Invariant: Do NOT clear requestId or locally dismiss offer on insufficient wallet.
        } else if (e.isOfferExpired) {
          _isExpired = true;
          _errorMessage = e.message;
        } else {
          _errorMessage = e.message;
        }
      });
    } catch (e) {
      if (!mounted) return;
      setState(() {
        _errorMessage = e.toString();
      });
    } finally {
      if (mounted) {
        setState(() {
          _isProcessing = false;
        });
      }
    }
  }

  Future<void> _handleDecline() async {
    if (_isProcessing) return;

    final requestId = _activeDeclineRequestId ??= _generateRequestId();

    setState(() {
      _isProcessing = true;
      _errorMessage = null;
    });

    try {
      final result = await widget.offerService.declineOffer(
        jobId: widget.offer.jobId,
        offerId: widget.offer.id,
        requestId: requestId,
      );

      if (mounted && result.declined) {
        _activeDeclineRequestId = null;
        widget.onResolved?.call();
      }
    } on OfferActionException catch (e) {
      if (!mounted) return;
      setState(() {
        _errorMessage = e.message;
      });
    } catch (e) {
      if (!mounted) return;
      setState(() {
        _errorMessage = e.toString();
      });
    } finally {
      if (mounted) {
        setState(() {
          _isProcessing = false;
        });
      }
    }
  }

  @override
  Widget build(BuildContext context) {
    final l10n = AppLocalizations.of(context)!;
    final offer = widget.offer;
    final secondsLeft = _remaining.inSeconds;

    return Card(
      key: const ValueKey('incoming_offer_sheet'),
      margin: const EdgeInsets.all(16.0),
      elevation: 8.0,
      shape: RoundedRectangleBorder(
        borderRadius: BorderRadius.circular(16.0),
        side: BorderSide(
          color: _isExpired
              ? AppColors.textSecondary
              : (_isInsufficientBalance ? AppColors.warning : AppColors.primary),
          width: 2.0,
        ),
      ),
      color: AppColors.surface,
      child: Padding(
        padding: const EdgeInsets.all(20.0),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            // Header with title and countdown badge (responsive Wrap for 360dp screens)
            Wrap(
              alignment: WrapAlignment.spaceBetween,
              crossAxisAlignment: WrapCrossAlignment.center,
              spacing: 8.0,
              runSpacing: 8.0,
              children: [
                ConstrainedBox(
                  constraints: const BoxConstraints(maxWidth: 260.0),
                  child: Row(
                    mainAxisSize: MainAxisSize.min,
                    children: [
                      const Icon(Icons.notifications_active, color: AppColors.primary),
                      const SizedBox(width: 8.0),
                      Flexible(
                        child: Text(
                          l10n.incomingOfferTitle,
                          style: AppTypography.titleLarge.copyWith(color: AppColors.onBackground),
                          overflow: TextOverflow.ellipsis,
                        ),
                      ),
                    ],
                  ),
                ),
                Container(
                  padding: const EdgeInsets.symmetric(horizontal: 10.0, vertical: 4.0),
                  decoration: BoxDecoration(
                    color: _isExpired
                        ? AppColors.error.withValues(alpha: 0.2)
                        : (secondsLeft <= 10
                            ? AppColors.warning.withValues(alpha: 0.2)
                            : AppColors.primary.withValues(alpha: 0.15)),
                    borderRadius: BorderRadius.circular(12.0),
                  ),
                  child: Text(
                    _isExpired
                        ? l10n.offerExpired
                        : l10n.offerExpiringIn(secondsLeft),
                    style: AppTypography.bodyMedium.copyWith(
                      fontSize: 12.0,
                      color: _isExpired
                          ? AppColors.error
                          : (secondsLeft <= 10 ? AppColors.warning : AppColors.primary),
                      fontWeight: FontWeight.bold,
                    ),
                  ),
                ),
              ],
            ),
            const Divider(height: 24.0),

            // Insufficient Balance Truthful Alert (Does not dismiss offer!)
            if (_isInsufficientBalance) ...[
              Container(
                key: const ValueKey('insufficient_balance_banner'),
                padding: const EdgeInsets.all(12.0),
                decoration: BoxDecoration(
                  color: AppColors.warning.withValues(alpha: 0.15),
                  borderRadius: BorderRadius.circular(8.0),
                  border: Border.all(color: AppColors.warning),
                ),
                child: Row(
                  children: [
                    const Icon(Icons.account_balance_wallet, color: AppColors.warning),
                    const SizedBox(width: 10.0),
                    Expanded(
                      child: Text(
                        l10n.insufficientWalletForOffer(offer.driverCommissionRupees.toStringAsFixed(2)),
                        style: AppTypography.bodyMedium.copyWith(fontSize: 12.0, color: AppColors.onBackground),
                      ),
                    ),
                  ],
                ),
              ),
              const SizedBox(height: 12.0),
            ],

            // General Error Message if any
            if (_errorMessage != null && !_isInsufficientBalance) ...[
              Container(
                key: const ValueKey('offer_error_banner'),
                padding: const EdgeInsets.all(12.0),
                decoration: BoxDecoration(
                  color: AppColors.error.withValues(alpha: 0.15),
                  borderRadius: BorderRadius.circular(8.0),
                  border: Border.all(color: AppColors.error),
                ),
                child: Text(
                  _errorMessage!,
                  style: AppTypography.bodyMedium.copyWith(fontSize: 12.0, color: AppColors.error),
                ),
              ),
              const SizedBox(height: 12.0),
            ],

            // Locations Card (Pickup & Destination)
            Row(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                const Icon(Icons.my_location, color: AppColors.primary, size: 20.0),
                const SizedBox(width: 8.0),
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(l10n.pickupLocation, style: AppTypography.bodyMedium.copyWith(fontSize: 12.0)),
                      Text(
                        'Lat: ${offer.pickupCoords.lat.toStringAsFixed(4)}, Lng: ${offer.pickupCoords.lng.toStringAsFixed(4)}',
                        style: AppTypography.bodyMedium,
                      ),
                    ],
                  ),
                ),
              ],
            ),
            const SizedBox(height: 8.0),
            Row(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                const Icon(Icons.location_on, color: AppColors.error, size: 20.0),
                const SizedBox(width: 8.0),
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(l10n.destinationLocation, style: AppTypography.bodyMedium.copyWith(fontSize: 12.0)),
                      Text(
                        'Lat: ${offer.destCoords.lat.toStringAsFixed(4)}, Lng: ${offer.destCoords.lng.toStringAsFixed(4)}',
                        style: AppTypography.bodyMedium,
                      ),
                    ],
                  ),
                ),
              ],
            ),
            const SizedBox(height: 16.0),

            // Distance, ETA & Truck Type Row
            Row(
              children: [
                if (offer.pickupDistanceKm != null)
                  Expanded(
                    child: _buildMetric(
                      label: l10n.pickupDistance,
                      value: '${offer.pickupDistanceKm!.toStringAsFixed(1)} km',
                    ),
                  ),
                if (offer.pickupEtaMinutes != null)
                  Expanded(
                    child: _buildMetric(
                      label: l10n.pickupEta,
                      value: '~${offer.pickupEtaMinutes} min',
                    ),
                  ),
                Expanded(
                  child: _buildMetric(
                    label: l10n.truckTypeLabel,
                    value: offer.requestedTruckType.toUpperCase(),
                  ),
                ),
              ],
            ),
            const SizedBox(height: 16.0),

            // Financial Summary (Fare & Commission)
            Container(
              padding: const EdgeInsets.all(12.0),
              decoration: BoxDecoration(
                color: AppColors.surfaceVariant,
                borderRadius: BorderRadius.circular(8.0),
              ),
              child: Row(
                children: [
                  Expanded(
                    child: Column(
                      children: [
                        Text(
                          l10n.estimatedEarnings,
                          style: AppTypography.bodyMedium.copyWith(fontSize: 12.0),
                          textAlign: TextAlign.center,
                          overflow: TextOverflow.ellipsis,
                        ),
                        const SizedBox(height: 2.0),
                        Text(
                          '₹${offer.estimatedFareRupees.toStringAsFixed(2)}',
                          style: AppTypography.titleLarge.copyWith(color: AppColors.success),
                          textAlign: TextAlign.center,
                          overflow: TextOverflow.ellipsis,
                        ),
                      ],
                    ),
                  ),
                  Container(height: 30.0, width: 1.0, color: AppColors.border),
                  Expanded(
                    child: Column(
                      children: [
                        Text(
                          l10n.commissionFee,
                          style: AppTypography.bodyMedium.copyWith(fontSize: 12.0),
                          textAlign: TextAlign.center,
                          overflow: TextOverflow.ellipsis,
                        ),
                        const SizedBox(height: 2.0),
                        Text(
                          '-₹${offer.driverCommissionRupees.toStringAsFixed(2)}',
                          style: AppTypography.titleLarge.copyWith(color: AppColors.error),
                          textAlign: TextAlign.center,
                          overflow: TextOverflow.ellipsis,
                        ),
                      ],
                    ),
                  ),
                ],
              ),
            ),
            const SizedBox(height: 20.0),

            // Action Buttons (DECLINE and ACCEPT)
            Row(
              children: [
                // Decline Button
                Expanded(
                  child: Semantics(
                    button: true,
                    label: l10n.declineOffer,
                    child: OutlinedButton(
                      key: const ValueKey('decline_offer_button'),
                      style: OutlinedButton.styleFrom(
                        foregroundColor: AppColors.error,
                        side: const BorderSide(color: AppColors.error),
                        minimumSize: const Size(double.infinity, 56.0),
                        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(8.0)),
                      ),
                      onPressed: (_isProcessing || _isExpired) ? null : _handleDecline,
                      child: Text(
                        l10n.declineOffer,
                        style: AppTypography.button.copyWith(color: AppColors.error),
                      ),
                    ),
                  ),
                ),
                const SizedBox(width: 12.0),

                // Accept Button
                Expanded(
                  child: Semantics(
                    button: true,
                    label: l10n.acceptOffer,
                    child: ElevatedButton(
                      key: const ValueKey('accept_offer_button'),
                      style: ElevatedButton.styleFrom(
                        backgroundColor: AppColors.success,
                        foregroundColor: Colors.white,
                        minimumSize: const Size(double.infinity, 56.0),
                        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(8.0)),
                      ),
                      onPressed: (_isProcessing || _isExpired) ? null : _handleAccept,
                      child: _isProcessing
                          ? const SizedBox(
                              width: 24.0,
                              height: 24.0,
                              child: CircularProgressIndicator(
                                strokeWidth: 2.5,
                                valueColor: AlwaysStoppedAnimation<Color>(Colors.white),
                              ),
                            )
                          : Text(
                              _activeAcceptRequestId != null
                                  ? l10n.retryAcceptOffer
                                  : l10n.acceptOffer,
                              style: AppTypography.button.copyWith(color: Colors.white),
                            ),
                    ),
                  ),
                ),
              ],
            ),
          ],
        ),
      ),
    );
  }

  Widget _buildMetric({required String label, required String value}) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text(
          label,
          style: AppTypography.bodyMedium.copyWith(fontSize: 12.0),
          overflow: TextOverflow.ellipsis,
        ),
        const SizedBox(height: 2.0),
        Text(
          value,
          style: AppTypography.bodyMedium.copyWith(fontWeight: FontWeight.bold),
          overflow: TextOverflow.ellipsis,
        ),
      ],
    );
  }
}
