import 'dart:math' as math;
import 'package:firebase_core/firebase_core.dart';
import 'package:flutter/material.dart';

import '../../../app/logout_coordinator.dart';
import '../../../core/models/driver_profile.dart';
import '../../../core/models/job_offer.dart';
import '../../../core/services/auth_service.dart';
import '../../../core/services/external_navigation_service.dart';
import '../../../core/services/location_service.dart';
import '../../../core/services/offer_service.dart';
import '../../../l10n/app_localizations.dart';
import '../../../theme/app_colors.dart';
import '../../../theme/app_typography.dart';
import '../../hub/controllers/duty_controller.dart';
import '../../hub/widgets/cancellation_preview_dialog.dart';

/// Phase 5 Batch 2 & 3 Active Job Screen.
///
/// Implements full accepted-job lifecycle operations:
/// - START TOW: transitions accepted -> in_progress
/// - MARK COMPLETE: transitions in_progress -> completed
/// - DRIVER CANCEL: pre-pickup cancellation with non-authoritative preview and
///   cancellation penalty presentation. Strictly disabled once tow is in progress.
/// - External pickup/destination navigation with >=56dp safety targets.
/// - Customer cancellation overlap: non-penalizing presentation and state reflection.
/// - RequestId semantics: one requestId per logical user operation with retry reuse.
/// - Single-flight guards: buttons synchronously locked during operation.
/// - Stage 3 logout blocker preserved.
class ActiveJobScreen extends StatefulWidget {
  final String jobId;
  final DriverProfile profile;
  final AuthService authService;
  final OfferService? offerService;
  final JobOffer? initialOffer;
  final Function(Locale)? onLocaleChanged;
  final AppLogoutCoordinator? logoutCoordinator;
  final DateTime Function()? clock;
  final Future<bool> Function(double lat, double lng)? onLaunchNavigation;
  final DutyController? controller;
  final LocationService? locationService;

  const ActiveJobScreen({
    super.key,
    required this.jobId,
    required this.profile,
    required this.authService,
    this.offerService,
    this.initialOffer,
    this.onLocaleChanged,
    this.logoutCoordinator,
    this.clock,
    this.onLaunchNavigation,
    this.controller,
    this.locationService,
  });

  @override
  State<ActiveJobScreen> createState() => _ActiveJobScreenState();
}

class _ActiveJobScreenState extends State<ActiveJobScreen> with WidgetsBindingObserver {
  OfferService? _offerService;
  Stream<JobOffer?>? _offerStream;
  late final LocationService _locationService;
  late final DutyController _controller;

  // In-flight operation guards
  bool _isStarting = false;
  bool _isCompleting = false;

  // Logical operation request IDs (reused on retry)
  String? _startRequestId;
  String? _completeRequestId;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);

    _locationService = widget.locationService ??
        DriverLocationService(
          auth: widget.authService.firebaseAuth,
        );
    _controller = widget.controller ??
        DutyController(
          locationService: _locationService,
          authService: widget.authService,
          clock: widget.clock,
        );
    _controller.updateProfile(widget.profile);

    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (mounted) {
        _controller.reconcileDutyState();
      }
    });

    if (widget.offerService != null) {
      _offerService = widget.offerService;
    } else {
      bool hasFirebase = false;
      try {
        hasFirebase = Firebase.apps.isNotEmpty;
      } catch (_) {
        hasFirebase = false;
      }
      if (hasFirebase) {
        _offerService = OfferService();
      }
    }

    if (_offerService != null) {
      _offerStream = _offerService!.streamAcceptedJobOffer(
        driverId: widget.profile.uid,
        jobId: widget.jobId,
      );
    }
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    if (state == AppLifecycleState.resumed) {
      _controller.reconcileDutyState();
    }
  }

  @override
  void didUpdateWidget(ActiveJobScreen oldWidget) {
    super.didUpdateWidget(oldWidget);
    _controller.updateProfile(widget.profile);
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    if (widget.controller == null) {
      _controller.dispose();
    }
    if (widget.locationService == null) {
      _locationService.dispose();
    }
    super.dispose();
  }

  Future<void> _handleStartTow(JobOffer offer) async {
    if (_isStarting || _offerService == null) return;

    setState(() {
      _isStarting = true;
      _startRequestId ??= 'req_start_${DateTime.now().millisecondsSinceEpoch}_${widget.jobId.substring(0, math.min(6, widget.jobId.length))}';
    });

    try {
      final result = await _offerService!.startJob(
        jobId: widget.jobId,
        offerId: offer.id,
        requestId: _startRequestId!,
      );

      if (!mounted) return;
      setState(() {
        _isStarting = false;
      });

      if (!result.started) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(
            content: Text(result.reason ?? 'Failed to start tow'),
            backgroundColor: AppColors.error,
          ),
        );
      }
    } catch (e) {
      if (!mounted) return;
      setState(() {
        _isStarting = false;
      });
      final msg = e is OfferActionException ? e.message : 'Network error starting tow. Retry available.';
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(
          content: Text(msg),
          backgroundColor: AppColors.error,
        ),
      );
    }
  }

  Future<void> _handleCompleteJob(JobOffer offer) async {
    if (_isCompleting || _offerService == null) return;

    final l10n = AppLocalizations.of(context)!;
    setState(() {
      _isCompleting = true;
      _completeRequestId ??= 'req_complete_${DateTime.now().millisecondsSinceEpoch}_${widget.jobId.substring(0, math.min(6, widget.jobId.length))}';
    });

    try {
      final result = await _offerService!.completeJob(
        jobId: widget.jobId,
        offerId: offer.id,
        requestId: _completeRequestId!,
      );

      if (!mounted) return;
      setState(() {
        _isCompleting = false;
      });

      if (result.completed) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(
            content: Text(l10n.jobCompletedSuccess),
            backgroundColor: AppColors.success,
          ),
        );
      } else {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(
            content: Text(result.reason ?? 'Failed to complete job'),
            backgroundColor: AppColors.error,
          ),
        );
      }
    } catch (e) {
      if (!mounted) return;
      setState(() {
        _isCompleting = false;
      });
      final msg = e is OfferActionException ? e.message : 'Network error completing job. Retry available.';
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(
          content: Text(msg),
          backgroundColor: AppColors.error,
        ),
      );
    }
  }

  Future<void> _handleLaunchNavigation({
    required double lat,
    required double lng,
    String? label,
  }) async {
    final l10n = AppLocalizations.of(context)!;
    bool launched = false;
    if (widget.onLaunchNavigation != null) {
      launched = await widget.onLaunchNavigation!(lat, lng);
    } else {
      launched = await ExternalNavigationService.launchNavigation(
        lat: lat,
        lng: lng,
        label: label,
      );
    }
    if (!launched && mounted) {
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(
          content: Text(l10n.navigationLaunchError),
          backgroundColor: AppColors.error,
        ),
      );
    }
  }

  void _openCancellationPreview(JobOffer offer) {
    if (_offerService == null) return;

    CancellationPreviewDialog.show(
      context: context,
      offer: offer,
      profile: widget.profile,
      offerService: _offerService!,
      clock: widget.clock,
      onCancelled: (result) {
        if (!mounted) return;
        final l10n = AppLocalizations.of(context)!;
        if (result.isCustomerCancelled) {
          ScaffoldMessenger.of(context).showSnackBar(
            SnackBar(
              content: Text(l10n.customerCancelledNotice),
              backgroundColor: AppColors.warning,
            ),
          );
        } else if (result.cancelled) {
          final forfeited = result.forfeitedRupees;
          final refund = result.refundRupees;
          ScaffoldMessenger.of(context).showSnackBar(
            SnackBar(
              content: Text(l10n.jobCancelledNotice(
                refund.toStringAsFixed(2),
                forfeited.toStringAsFixed(2),
              )),
              backgroundColor: AppColors.surfaceVariant,
            ),
          );
        }
      },
    );
  }

  @override
  Widget build(BuildContext context) {
    final l10n = AppLocalizations.of(context)!;

    return Scaffold(
      appBar: AppBar(
        title: Text(l10n.activeJobTitle),
        actions: [
          // Wallet balance display in AppBar
          Padding(
            padding: const EdgeInsets.symmetric(horizontal: 8.0),
            child: Chip(
              backgroundColor: AppColors.primaryContainer,
              avatar: const Icon(Icons.account_balance_wallet, size: 16.0, color: AppColors.primary),
              label: Text(
                widget.profile.formattedWalletBalance,
                style: AppTypography.bodyMedium.copyWith(
                  fontWeight: FontWeight.bold,
                  color: AppColors.primary,
                  fontSize: 12.0,
                ),
              ),
            ),
          ),
          if (widget.onLocaleChanged != null)
            PopupMenuButton<Locale>(
              icon: const Icon(Icons.language, color: AppColors.primary),
              tooltip: l10n.selectLanguage,
              onSelected: widget.onLocaleChanged,
              itemBuilder: (context) => [
                const PopupMenuItem(value: Locale('en'), child: Text('English')),
                const PopupMenuItem(value: Locale('hi'), child: Text('हिन्दी (Hindi)')),
                const PopupMenuItem(value: Locale('mr'), child: Text('मराठी (Marathi)')),
              ],
            ),
          IconButton(
            icon: const Icon(Icons.logout, color: AppColors.error),
            tooltip: l10n.logout,
            onPressed: () async {
              if (widget.profile.hasActiveJob) {
                ScaffoldMessenger.of(context).showSnackBar(
                  SnackBar(
                    content: Text(l10n.logoutBlockedActiveJob),
                    backgroundColor: AppColors.error,
                  ),
                );
                return;
              }
              final coordinator = widget.logoutCoordinator ??
                  AppLogoutCoordinator(
                    authService: widget.authService,
                  );
              await coordinator.coordinateLogout(
                profile: widget.profile,
                context: context,
              );
            },
          ),
        ],
      ),
      body: SafeArea(
        child: StreamBuilder<JobOffer?>(
          stream: _offerStream,
          initialData: widget.initialOffer,
          builder: (context, snapshot) {
            final offer = snapshot.data ?? widget.initialOffer;

            return SingleChildScrollView(
              padding: const EdgeInsets.all(20.0),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  // Status Banner Card
                  _buildStatusBanner(context, l10n, offer),
                  const SizedBox(height: 16.0),

                  // Customer Cancellation Notice if applicable
                  if (offer?.status == JobOfferStatus.cancelledCustomer) ...[
                    _buildCustomerCancelledBanner(l10n),
                    const SizedBox(height: 16.0),
                  ],

                  // Job Identification Card
                  _buildIdentificationCard(l10n),
                  const SizedBox(height: 16.0),

                  // Locations & Route Card
                  if (offer != null) ...[
                    _buildRouteCard(l10n, offer),
                    const SizedBox(height: 16.0),

                    // Financial Summary Card
                    _buildFinancialCard(l10n, offer),
                    const SizedBox(height: 16.0),

                    // Cancellation Policy Card (if snapshot exists)
                    if (offer.cancellationPolicySnapshot != null) ...[
                      _buildPolicyCard(l10n, offer),
                      const SizedBox(height: 16.0),
                    ],

                    // Action Controls Section
                    _buildActionControls(context, l10n, offer),
                  ] else ...[
                    const Center(
                      child: Padding(
                        padding: EdgeInsets.all(32.0),
                        child: CircularProgressIndicator(),
                      ),
                    ),
                  ],
                ],
              ),
            );
          },
        ),
      ),
    );
  }

  Widget _buildCustomerCancelledBanner(AppLocalizations l10n) {
    return Container(
      key: const ValueKey('customer_cancelled_banner'),
      padding: const EdgeInsets.all(14.0),
      decoration: BoxDecoration(
        color: AppColors.warning.withValues(alpha: 0.15),
        borderRadius: BorderRadius.circular(10.0),
        border: Border.all(color: AppColors.warning),
      ),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          const Icon(Icons.info_outline, color: AppColors.warning, size: 22.0),
          const SizedBox(width: 10.0),
          Expanded(
            child: Text(
              l10n.customerCancelledNotice,
              style: AppTypography.bodyMedium.copyWith(
                fontWeight: FontWeight.w600,
                color: AppColors.onBackground,
              ),
            ),
          ),
        ],
      ),
    );
  }

  Widget _buildActionControls(BuildContext context, AppLocalizations l10n, JobOffer offer) {
    final status = offer.status;

    // ACCEPTED STATE: NAVIGATE TO PICKUP + START TOW + CANCEL JOB
    if (status == JobOfferStatus.accepted) {
      return Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          // External Navigation: Navigate to Pickup
          Semantics(
            button: true,
            label: l10n.navigateToPickup,
            hint: 'Opens external map navigation to customer pickup location',
            child: FilledButton.icon(
              key: const ValueKey('navigate_pickup_button'),
              style: FilledButton.styleFrom(
                backgroundColor: AppColors.primary,
                minimumSize: const Size(double.infinity, 56.0),
              ),
              onPressed: () => _handleLaunchNavigation(
                lat: offer.pickupCoords.lat,
                lng: offer.pickupCoords.lng,
                label: 'Pickup',
              ),
              icon: const Icon(Icons.navigation, color: Colors.white),
              label: Text(
                l10n.navigateToPickup,
                style: AppTypography.titleLarge.copyWith(color: Colors.white, fontSize: 16.0),
              ),
            ),
          ),
          const SizedBox(height: 12.0),

          // Primary Lifecycle: Start Tow
          Semantics(
            button: true,
            label: l10n.startTow,
            hint: 'Transitions job status to in progress upon towing',
            child: FilledButton.icon(
              key: const ValueKey('start_tow_button'),
              style: FilledButton.styleFrom(
                backgroundColor: AppColors.success,
                minimumSize: const Size(double.infinity, 56.0),
              ),
              onPressed: _isStarting ? null : () => _handleStartTow(offer),
              icon: _isStarting
                  ? const SizedBox(
                      width: 18.0,
                      height: 18.0,
                      child: CircularProgressIndicator(strokeWidth: 2.0, color: Colors.white),
                    )
                  : const Icon(Icons.directions_car, color: Colors.white),
              label: Text(
                _startRequestId != null && _isStarting ? l10n.actionInProgress : l10n.startTow,
                style: AppTypography.titleLarge.copyWith(color: Colors.white, fontSize: 16.0),
              ),
            ),
          ),
          const SizedBox(height: 12.0),

          // Pre-pickup Cancellation
          Semantics(
            button: true,
            label: l10n.cancelJob,
            hint: 'Opens cancellation preview modal',
            child: OutlinedButton.icon(
              key: const ValueKey('cancel_job_button'),
              style: OutlinedButton.styleFrom(
                foregroundColor: AppColors.error,
                side: const BorderSide(color: AppColors.error),
                minimumSize: const Size(double.infinity, 56.0),
              ),
              onPressed: _isStarting ? null : () => _openCancellationPreview(offer),
              icon: const Icon(Icons.cancel_outlined, color: AppColors.error),
              label: Text(
                l10n.cancelJob,
                style: AppTypography.bodyMedium.copyWith(color: AppColors.error, fontWeight: FontWeight.bold),
              ),
            ),
          ),
        ],
      );
    }

    // IN PROGRESS STATE: NAVIGATE TO DESTINATION + MARK COMPLETE (CANCEL UNAVAILABLE)
    if (status == JobOfferStatus.inProgress) {
      return Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          // External Navigation: Navigate to Destination
          Semantics(
            button: true,
            label: l10n.navigateToDestination,
            hint: 'Opens external map navigation to drop-off destination',
            child: FilledButton.icon(
              key: const ValueKey('navigate_destination_button'),
              style: FilledButton.styleFrom(
                backgroundColor: AppColors.primary,
                minimumSize: const Size(double.infinity, 56.0),
              ),
              onPressed: () => _handleLaunchNavigation(
                lat: offer.destCoords.lat,
                lng: offer.destCoords.lng,
                label: 'Destination',
              ),
              icon: const Icon(Icons.navigation, color: Colors.white),
              label: Text(
                l10n.navigateToDestination,
                style: AppTypography.titleLarge.copyWith(color: Colors.white, fontSize: 16.0),
              ),
            ),
          ),
          const SizedBox(height: 12.0),

          // Primary Lifecycle: Mark Complete
          Semantics(
            button: true,
            label: l10n.markComplete,
            hint: 'Marks towing job completed',
            child: FilledButton.icon(
              key: const ValueKey('complete_job_button'),
              style: FilledButton.styleFrom(
                backgroundColor: AppColors.success,
                minimumSize: const Size(double.infinity, 56.0),
              ),
              onPressed: _isCompleting ? null : () => _handleCompleteJob(offer),
              icon: _isCompleting
                  ? const SizedBox(
                      width: 18.0,
                      height: 18.0,
                      child: CircularProgressIndicator(strokeWidth: 2.0, color: Colors.white),
                    )
                  : const Icon(Icons.check_circle_outline, color: Colors.white),
              label: Text(
                _completeRequestId != null && _isCompleting ? l10n.actionInProgress : l10n.markComplete,
                style: AppTypography.titleLarge.copyWith(color: Colors.white, fontSize: 16.0),
              ),
            ),
          ),
          const SizedBox(height: 8.0),
          // Informational note: cancel unavailable during in_progress
          Center(
            child: Text(
              l10n.cancelUnavailableInProgress,
              style: AppTypography.bodyMedium.copyWith(fontSize: 11.0, color: AppColors.textSecondary),
            ),
          ),
        ],
      );
    }

    // TERMINAL STATE: COMPLETED
    if (status == JobOfferStatus.completed) {
      return Container(
        padding: const EdgeInsets.all(16.0),
        decoration: BoxDecoration(
          color: AppColors.success.withValues(alpha: 0.12),
          borderRadius: BorderRadius.circular(12.0),
          border: Border.all(color: AppColors.success),
        ),
        child: Column(
          children: [
            const Icon(Icons.task_alt, color: AppColors.success, size: 36.0),
            const SizedBox(height: 8.0),
            Text(
              l10n.jobCompletedSuccess,
              style: AppTypography.titleLarge.copyWith(color: AppColors.success, fontWeight: FontWeight.bold),
            ),
          ],
        ),
      );
    }

    // OTHER TERMINAL STATES (cancelled)
    return const SizedBox.shrink();
  }

  Widget _buildStatusBanner(BuildContext context, AppLocalizations l10n, JobOffer? offer) {
    final status = offer?.status;
    Color color = AppColors.success;
    String label = l10n.activeJobStatusAssigned;

    if (status == JobOfferStatus.inProgress) {
      color = AppColors.primary;
      label = l10n.activeJobStatusInProgress;
    } else if (status == JobOfferStatus.completed) {
      color = AppColors.success;
      label = l10n.activeJobStatusCompleted;
    } else if (status == JobOfferStatus.cancelledDriver || status == JobOfferStatus.cancelledCustomer) {
      color = AppColors.error;
      label = l10n.activeJobStatusCancelled;
    }

    return Semantics(
      container: true,
      label: label,
      child: Container(
        padding: const EdgeInsets.symmetric(horizontal: 16.0, vertical: 12.0),
        decoration: BoxDecoration(
          color: color.withValues(alpha: 0.15),
          borderRadius: BorderRadius.circular(12.0),
          border: Border.all(color: color),
        ),
        child: Row(
          mainAxisAlignment: MainAxisAlignment.spaceBetween,
          children: [
            Row(
              children: [
                Icon(Icons.directions_car, color: color),
                const SizedBox(width: 8.0),
                Text(
                  label,
                  style: AppTypography.titleLarge.copyWith(color: color),
                ),
              ],
            ),
            Container(
              padding: const EdgeInsets.symmetric(horizontal: 8.0, vertical: 4.0),
              decoration: BoxDecoration(
                color: color,
                borderRadius: BorderRadius.circular(6.0),
              ),
              child: Text(
                label,
                style: AppTypography.bodyMedium.copyWith(fontSize: 12.0, color: Colors.white, fontWeight: FontWeight.bold),
              ),
            ),
          ],
        ),
      ),
    );
  }

  Widget _buildIdentificationCard(AppLocalizations l10n) {
    return Card(
      child: Padding(
        padding: const EdgeInsets.all(16.0),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(l10n.jobIdLabel, style: AppTypography.bodyMedium.copyWith(fontSize: 12.0)),
            const SizedBox(height: 4.0),
            SelectableText(
              widget.jobId,
              style: AppTypography.titleLarge.copyWith(color: AppColors.primary),
            ),
          ],
        ),
      ),
    );
  }

  Widget _buildRouteCard(AppLocalizations l10n, JobOffer offer) {
    return Card(
      child: Padding(
        padding: const EdgeInsets.all(16.0),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(l10n.routeDetailsTitle, style: AppTypography.titleLarge),
            const Divider(height: 20.0),
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
            const SizedBox(height: 12.0),
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
            const SizedBox(height: 12.0),
            Row(
              mainAxisAlignment: MainAxisAlignment.spaceBetween,
              children: [
                Text('${l10n.truckTypeLabel}: ${offer.requestedTruckType.toUpperCase()}',
                    style: AppTypography.bodyMedium.copyWith(fontSize: 12.0, fontWeight: FontWeight.bold)),
                if (offer.pickupDistanceKm != null)
                  Text('${offer.pickupDistanceKm!.toStringAsFixed(1)} km', style: AppTypography.bodyMedium.copyWith(fontSize: 12.0)),
              ],
            ),
          ],
        ),
      ),
    );
  }

  Widget _buildFinancialCard(AppLocalizations l10n, JobOffer offer) {
    return Card(
      child: Padding(
        padding: const EdgeInsets.all(16.0),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(l10n.paymentSummaryTitle, style: AppTypography.titleLarge),
            const Divider(height: 20.0),
            Row(
              mainAxisAlignment: MainAxisAlignment.spaceBetween,
              children: [
                Text(l10n.estimatedEarnings, style: AppTypography.bodyMedium),
                Text(
                  '₹${offer.estimatedFareRupees.toStringAsFixed(2)}',
                  style: AppTypography.bodyMedium.copyWith(color: AppColors.success, fontWeight: FontWeight.bold),
                ),
              ],
            ),
            const SizedBox(height: 8.0),
            Row(
              mainAxisAlignment: MainAxisAlignment.spaceBetween,
              children: [
                Text(l10n.commissionFee, style: AppTypography.bodyMedium),
                Text(
                  '-₹${offer.driverCommissionRupees.toStringAsFixed(2)}',
                  style: AppTypography.bodyMedium.copyWith(color: AppColors.error, fontWeight: FontWeight.bold),
                ),
              ],
            ),
          ],
        ),
      ),
    );
  }

  Widget _buildPolicyCard(AppLocalizations l10n, JobOffer offer) {
    final policy = offer.cancellationPolicySnapshot!;
    final free = policy['freeCancellationsPerMonth'] ?? policy['free_cancellations_per_month'] ?? 1;

    return Card(
      child: Padding(
        padding: const EdgeInsets.all(16.0),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(l10n.cancellationPolicyTitle, style: AppTypography.titleLarge),
            const SizedBox(height: 6.0),
            Text(
              l10n.cancellationPolicyDescription(free.toString()),
              style: AppTypography.bodyMedium.copyWith(fontSize: 12.0, color: AppColors.textSecondary),
            ),
          ],
        ),
      ),
    );
  }
}
