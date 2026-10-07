import 'dart:async';
import 'package:firebase_core/firebase_core.dart';
import 'package:flutter/material.dart';
import 'package:geolocator/geolocator.dart';

import '../../../core/models/driver_profile.dart';
import '../../../core/models/job_offer.dart';
import '../../../core/services/auth_service.dart';
import '../../../core/services/location_service.dart';
import '../../../core/services/offer_service.dart';
import '../../../l10n/app_localizations.dart';
import '../../../theme/app_colors.dart';
import '../../../theme/app_typography.dart';
import '../controllers/duty_controller.dart';
import '../models/duty_state.dart';
import '../models/hub_error_category.dart';
import '../widgets/battery_optimization_card.dart';
import '../widgets/driver_map_view.dart';
import '../widgets/duty_toggle_button.dart';
import '../widgets/incoming_offer_sheet.dart';
import '../widgets/location_disclosure_dialog.dart';
import '../widgets/temporary_ban_banner.dart';
import '../widgets/wallet_topup_sheet.dart';
import '../../../app/logout_coordinator.dart';

/// Phase 5 Stage 3 Dispatch Hub Screen.
///
/// Serves as the operational home for verified/approved drivers:
/// - Real-time map preview with driver position pin
/// - Giant interactive ON DUTY / OFF DUTY control
/// - Temporary cancellation ban banner (presentation only)
/// - Transactional permission & background disclosure flows
/// - Fail-closed restart reconciliation with state-separated health
class DispatchHubScreen extends StatefulWidget {
  final DriverProfile profile;
  final AuthService authService;
  final LocationService? locationService;
  final DutyController? controller;
  final OfferService? offerService;
  final Function(Locale)? onLocaleChanged;
  final MapWidgetBuilder? mapWidgetBuilder;
  final DateTime Function()? clock;

  const DispatchHubScreen({
    super.key,
    required this.profile,
    required this.authService,
    this.locationService,
    this.controller,
    this.offerService,
    this.onLocaleChanged,
    this.mapWidgetBuilder,
    this.clock,
  });

  @override
  State<DispatchHubScreen> createState() => _DispatchHubScreenState();
}

class _DispatchHubScreenState extends State<DispatchHubScreen> with WidgetsBindingObserver {
  late final LocationService _locationService;
  late final DutyController _controller;
  OfferService? _offerService;
  StreamSubscription<DriverPosition>? _positionSubscription;
  DriverPosition? _currentPosition;
  StreamSubscription<JobOffer?>? _offerSubscription;
  JobOffer? _currentOffer;
  String? _subscribedOfferId;

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

    _controller.updateProfile(widget.profile);
    _controller.addListener(_onControllerUpdated);

    if (widget.profile.isOnDuty) {
      _startLocationTracking();
    }

    _subscribeToOffer(widget.profile.activeOfferId);

    // Reconcile duty state with Firestore on initial screen load
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (mounted) {
        _controller.reconcileDutyState();
      }
    });
  }

  void _subscribeToOffer(String? activeOfferId) {
    if (activeOfferId == _subscribedOfferId) return;
    _subscribedOfferId = activeOfferId;
    _offerSubscription?.cancel();
    _offerSubscription = null;

    // Immediately clear stale offer presentation on any activeOfferId change
    _currentOffer = null;
    if (mounted) {
      setState(() {});
    }

    if (activeOfferId == null || activeOfferId.isEmpty) {
      return;
    }

    final service = _offerService;
    if (service == null) return;

    final driverId = widget.profile.uid;
    _offerSubscription = service.streamActiveOffer(
      driverId: driverId,
      activeOfferId: activeOfferId,
    ).listen(
      (offer) {
        if (mounted) {
          setState(() {
            _currentOffer = offer;
          });
        }
      },
      onError: (_) {
        if (mounted) {
          setState(() {
            _currentOffer = null;
          });
        }
      },
    );
  }

  void _startLocationTracking() {
    _stopLocationTracking();
    _positionSubscription = _locationService.getPositionStream().listen(
      (pos) {
        if (mounted) {
          setState(() {
            _currentPosition = pos;
          });
        }
      },
      onError: (_) {},
      cancelOnError: false,
    );

    _locationService.getCurrentPosition().then((pos) {
      if (mounted && pos != null) {
        setState(() {
          _currentPosition = pos;
        });
      }
    });
  }

  void _stopLocationTracking() {
    _positionSubscription?.cancel();
    _positionSubscription = null;
    _currentPosition = null;
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    if (state == AppLifecycleState.resumed) {
      _controller.reconcileDutyState();
    }
  }

  @override
  void didUpdateWidget(DispatchHubScreen oldWidget) {
    super.didUpdateWidget(oldWidget);
    _controller.updateProfile(widget.profile);
    if (widget.profile.isOnDuty != oldWidget.profile.isOnDuty) {
      if (widget.profile.isOnDuty) {
        _startLocationTracking();
      } else {
        _stopLocationTracking();
      }
      _controller.reconcileDutyState();
    }

    final currentOfferId = widget.profile.activeOfferId;
    if (currentOfferId != oldWidget.profile.activeOfferId) {
      _subscribeToOffer(currentOfferId);
    }
  }

  void _onControllerUpdated() {
    if (mounted) {
      final currentOfferId = _controller.currentProfile != null
          ? _controller.currentProfile!.activeOfferId
          : widget.profile.activeOfferId;
      if (currentOfferId != _subscribedOfferId) {
        _subscribeToOffer(currentOfferId);
      }
      if (_controller.isOnDuty && _positionSubscription == null) {
        _startLocationTracking();
      } else if (!_controller.isOnDuty && _positionSubscription != null) {
        _stopLocationTracking();
      }
      setState(() {});
    }
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    _controller.removeListener(_onControllerUpdated);
    _stopLocationTracking();
    _offerSubscription?.cancel();
    if (widget.controller == null) {
      _controller.dispose();
    }
    super.dispose();
  }

  Future<void> _handleDutyToggle() async {
    final l10n = AppLocalizations.of(context)!;
    final isOnDuty = _controller.isOnDuty;

    if (isOnDuty) {
      await _controller.requestGoOffDuty();
    } else {
      await _controller.requestGoOnDuty(
        onShowDisclosure: () => LocationDisclosureDialog.show(context),
        notificationTitle: l10n.foregroundNotificationTitle,
        notificationText: l10n.foregroundNotificationText,
        locale: Localizations.localeOf(context).languageCode,
      );
    }
  }

  @override
  Widget build(BuildContext context) {
    final l10n = AppLocalizations.of(context)!;
    final isOnDuty = _controller.isOnDuty;
    final errorCategory = _controller.errorCategory;
    final currentProfile = _controller.currentProfile ?? widget.profile;

    return Scaffold(
      appBar: AppBar(
        title: Text(l10n.dispatchHub),
        actions: [
          if (widget.onLocaleChanged != null)
            PopupMenuButton<Locale>(
              icon: const Icon(Icons.language, color: AppColors.primary),
              tooltip: l10n.selectLanguage,
              onSelected: widget.onLocaleChanged,
              itemBuilder: (context) => [
                const PopupMenuItem(
                  value: Locale('en'),
                  child: Text('English'),
                ),
                const PopupMenuItem(
                  value: Locale('hi'),
                  child: Text('हिन्दी (Hindi)'),
                ),
                const PopupMenuItem(
                  value: Locale('mr'),
                  child: Text('मराठी (Marathi)'),
                ),
              ],
            ),
          IconButton(
            icon: const Icon(Icons.logout, color: AppColors.error),
            tooltip: l10n.logout,
            onPressed: () async {
              final coordinator = AppLogoutCoordinator(
                authService: widget.authService,
                dutyController: _controller,
              );
              await coordinator.coordinateLogout(
                profile: currentProfile,
                context: context,
              );
            },
          ),
        ],
      ),
      body: SafeArea(
        child: SingleChildScrollView(
          padding: const EdgeInsets.all(20.0),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              // Temporary ban banner (if applicable)
              if (currentProfile.isTemporarilyBannedAt(widget.clock != null ? widget.clock!() : DateTime.now()))
                TemporaryBanBanner(
                  bannedUntil: currentProfile.bannedUntil,
                  clock: widget.clock,
                ),

              // Real-time wallet balance summary card
              _buildWalletCard(context, currentProfile, l10n),
              const SizedBox(height: 16.0),

              // Low-balance informational warning banner (non-blocking for duty toggle)
              if (currentProfile.isLowBalance &&
                  !currentProfile.isTemporarilyBannedAt(widget.clock != null ? widget.clock!() : DateTime.now())) ...[
                _buildLowBalanceWarningCard(context, currentProfile, l10n),
                const SizedBox(height: 16.0),
              ],

              // Error banner if any error occurred
              if (errorCategory != null) ...[
                _buildErrorCard(context, errorCategory, l10n),
                const SizedBox(height: 16.0),
              ],

              // Incoming Dispatch Offer Sheet (authoritative activeOfferId & status == offered & onDuty)
              if (_currentOffer != null &&
                  currentProfile.activeOfferId != null &&
                  _currentOffer!.id == currentProfile.activeOfferId &&
                  isOnDuty &&
                  _currentOffer!.isOffered &&
                  _offerService != null) ...[
                IncomingOfferSheet(
                  key: ValueKey('incoming_offer_${_currentOffer!.id}'),
                  offer: _currentOffer!,
                  offerService: _offerService!,
                  clock: widget.clock,
                ),
                const SizedBox(height: 16.0),
              ],

              // Map visualization card
              DriverMapView(
                currentPosition: _currentPosition,
                mapWidgetBuilder: widget.mapWidgetBuilder,
              ),
              const SizedBox(height: 16.0),

              // Status indicator banner (Medium: separates duty authority from tracking health)
              _buildStatusCard(l10n),
              const SizedBox(height: 20.0),

              // Giant ON DUTY / OFF DUTY Toggle
              DutyToggleButton(
                isOnDuty: isOnDuty,
                isLoading: _controller.isLoading,
                isEnabled: _controller.canToggleDuty,
                onPressed: _handleDutyToggle,
              ),
              const SizedBox(height: 24.0),

              // Driver & Vehicle summary card
              _buildDriverSummaryCard(currentProfile, l10n),
              const SizedBox(height: 16.0),

              // Battery optimization guidance card
              const BatteryOptimizationCard(),
            ],
          ),
        ),
      ),
    );
  }

  Widget _buildStatusCard(AppLocalizations l10n) {
    final authoritativeDuty = _controller.authoritativeDutyState;
    final trackingHealth = _controller.trackingHealth;

    final bool isAuthoritativeOn = authoritativeDuty == AuthoritativeDutyState.onDuty;
    final bool isAuthoritativeUnknown =
        authoritativeDuty == AuthoritativeDutyState.unknown;

    Color statusColor;
    String statusTitle;
    String statusSubtitle;
    Widget? trailingAction;

    if (_controller.isCleanupRequired ||
        trackingHealth == TrackingHealth.reconciliationFailed) {
      statusColor = AppColors.error;
      statusTitle = l10n.dutyAttentionRequired;
      statusSubtitle = _controller.isCleanupRequired
          ? 'Cleanup required'
          : l10n.reconciliationFailed;
      trailingAction = TextButton(
        key: const ValueKey('retry_cleanup_button'),
        onPressed: _controller.retryCleanup,
        child: Text(
          l10n.retry,
          style: const TextStyle(color: AppColors.error, fontWeight: FontWeight.bold),
        ),
      );
    } else if (isAuthoritativeUnknown || _controller.isReconciling) {
      statusColor = AppColors.warning;
      statusTitle = l10n.dutyAttentionRequired;
      statusSubtitle = _controller.isReconciling
          ? l10n.dutyTransitionInProgress
          : l10n.reconciliationFailed;
    } else if (isAuthoritativeOn) {
      if (_controller.isReady) {
        statusColor = AppColors.success;
        statusTitle = l10n.onDuty;
        statusSubtitle = l10n.hubStatusOnDuty;
      } else if (trackingHealth == TrackingHealth.starting) {
        statusColor = AppColors.warning;
        statusTitle = l10n.onDuty;
        statusSubtitle = l10n.dutyTransitionInProgress;
      } else {
        statusColor = AppColors.warning;
        statusTitle = l10n.onDuty;
        statusSubtitle = l10n.dutyAttentionRequired;
      }
    } else {
      statusColor = AppColors.textSecondary;
      statusTitle = l10n.offDuty;
      statusSubtitle = l10n.hubStatusOffDuty;
    }

    return Container(
      key: const ValueKey('duty_status_card'),
      padding: const EdgeInsets.all(16.0),
      decoration: BoxDecoration(
        color: AppColors.surface,
        borderRadius: BorderRadius.circular(AppColors.borderRadius),
        border: Border.all(
          color: statusColor,
          width: isAuthoritativeOn ? 1.5 : 1.0,
        ),
      ),
      child: LayoutBuilder(
        builder: (context, constraints) {
          final statusLine = Row(
            crossAxisAlignment: CrossAxisAlignment.center,
            children: [
              Container(
                width: 14.0,
                height: 14.0,
                decoration: BoxDecoration(
                  color: statusColor,
                  shape: BoxShape.circle,
                ),
              ),
              const SizedBox(width: 14.0),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      statusTitle,
                      style: AppTypography.titleLarge.copyWith(
                        color: statusColor,
                        fontWeight: FontWeight.bold,
                      ),
                    ),
                    const SizedBox(height: 2.0),
                    Text(
                      statusSubtitle,
                      style: AppTypography.bodyMedium.copyWith(
                        color: AppColors.textSecondary,
                      ),
                    ),
                  ],
                ),
              ),
              if (constraints.maxWidth > 320) ?trailingAction,
            ],
          );
          if (trailingAction == null || constraints.maxWidth > 320) {
            return statusLine;
          }
          return Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              statusLine,
              Align(alignment: Alignment.centerRight, child: trailingAction),
            ],
          );
        },
      ),
    );
  }

  Widget _buildErrorCard(
    BuildContext context,
    HubErrorCategory category,
    AppLocalizations l10n,
  ) {
    final showSettings = category == HubErrorCategory.foregroundPermissionDeniedForever ||
        category == HubErrorCategory.servicesDisabled ||
        category == HubErrorCategory.backgroundPermissionDenied;

    return Container(
      key: const ValueKey('hub_error_card'),
      padding: const EdgeInsets.all(14.0),
      decoration: BoxDecoration(
        color: const Color(0xFF330005),
        borderRadius: BorderRadius.circular(AppColors.borderRadius),
        border: Border.all(color: AppColors.error),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              const Icon(
                Icons.error_outline,
                color: AppColors.error,
                size: 24.0,
              ),
              const SizedBox(width: 10.0),
              Expanded(
                child: Text(
                  category.localizedMessage(l10n),
                  style: AppTypography.bodyMedium.copyWith(
                    color: AppColors.onBackground,
                    fontWeight: FontWeight.w500,
                  ),
                ),
              ),
              IconButton(
                icon: const Icon(Icons.close, size: 20.0, color: AppColors.error),
                onPressed: _controller.clearError,
                tooltip: l10n.cancelAction,
                padding: EdgeInsets.zero,
                constraints: const BoxConstraints(),
              ),
            ],
          ),
          if (showSettings) ...[
            const SizedBox(height: 10.0),
            Align(
              alignment: Alignment.centerRight,
              child: TextButton.icon(
                key: const ValueKey('hub_open_settings_button'),
                onPressed: () => Geolocator.openAppSettings(),
                icon: const Icon(Icons.settings, size: 18.0),
                label: Text(l10n.openSettings),
                style: TextButton.styleFrom(
                  foregroundColor: AppColors.error,
                ),
              ),
            ),
          ],
        ],
      ),
    );
  }

  Widget _buildWalletCard(BuildContext context, DriverProfile profile, AppLocalizations l10n) {
    return Container(
      key: const ValueKey('hub_wallet_card'),
      padding: const EdgeInsets.symmetric(horizontal: 14.0, vertical: 10.0),
      decoration: BoxDecoration(
        color: AppColors.surface,
        borderRadius: BorderRadius.circular(AppColors.borderRadius),
        border: Border.all(color: AppColors.border),
      ),
      child: Row(
        mainAxisAlignment: MainAxisAlignment.spaceBetween,
        children: [
          Expanded(
            child: Row(
              children: [
                const Icon(Icons.account_balance_wallet, color: AppColors.primary, size: 22.0),
                const SizedBox(width: 10.0),
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(l10n.walletBalance, style: AppTypography.bodyMedium.copyWith(fontSize: 11.0, color: AppColors.textSecondary)),
                      Text(
                        profile.formattedWalletBalance,
                        style: AppTypography.titleLarge.copyWith(fontWeight: FontWeight.bold, color: AppColors.primary, fontSize: 16.0),
                        overflow: TextOverflow.ellipsis,
                      ),
                    ],
                  ),
                ),
              ],
            ),
          ),
          if (_offerService != null) ...[
            const SizedBox(width: 8.0),
            FilledButton.tonal(
              key: const ValueKey('hub_wallet_topup_button'),
              style: FilledButton.styleFrom(
                padding: const EdgeInsets.symmetric(horizontal: 12.0, vertical: 6.0),
              ),
              onPressed: () {
                WalletTopupSheet.show(
                  context: context,
                  profile: profile,
                  offerService: _offerService!,
                );
              },
              child: Text(l10n.walletTopup, style: const TextStyle(fontWeight: FontWeight.bold, fontSize: 12.0)),
            ),
          ],
        ],
      ),
    );
  }

  Widget _buildLowBalanceWarningCard(BuildContext context, DriverProfile profile, AppLocalizations l10n) {
    return Container(
      key: const ValueKey('low_balance_warning_card'),
      padding: const EdgeInsets.symmetric(horizontal: 12.0, vertical: 8.0),
      decoration: BoxDecoration(
        color: AppColors.warning.withValues(alpha: 0.12),
        borderRadius: BorderRadius.circular(10.0),
        border: Border.all(color: AppColors.warning),
      ),
      child: Row(
        children: [
          const Icon(Icons.warning_amber_rounded, color: AppColors.warning, size: 20.0),
          const SizedBox(width: 8.0),
          Expanded(
            child: Text(
              l10n.lowBalanceWarning(profile.formattedWalletBalance),
              style: AppTypography.bodyMedium.copyWith(fontSize: 11.0, color: AppColors.onBackground),
            ),
          ),
          if (_offerService != null) ...[
            const SizedBox(width: 6.0),
            TextButton(
              key: const ValueKey('low_balance_topup_button'),
              style: TextButton.styleFrom(
                padding: const EdgeInsets.symmetric(horizontal: 8.0, vertical: 4.0),
              ),
              onPressed: () {
                WalletTopupSheet.show(
                  context: context,
                  profile: profile,
                  offerService: _offerService!,
                );
              },
              child: Text(
                l10n.walletTopup,
                style: const TextStyle(fontWeight: FontWeight.bold, color: AppColors.primary, fontSize: 12.0),
              ),
            ),
          ],
        ],
      ),
    );
  }

  Widget _buildDriverSummaryCard(DriverProfile profile, AppLocalizations l10n) {
    return Card(
      key: const ValueKey('driver_summary_card'),
      child: Padding(
        padding: const EdgeInsets.all(16.0),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              children: [
                CircleAvatar(
                  radius: 24.0,
                  backgroundColor: AppColors.primaryContainer,
                  child: const Icon(
                    Icons.person,
                    color: AppColors.primary,
                    size: 28.0,
                  ),
                ),
                const SizedBox(width: 16.0),
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(
                        profile.name,
                        style: AppTypography.titleLarge.copyWith(
                          fontWeight: FontWeight.bold,
                        ),
                      ),
                      const SizedBox(height: 4.0),
                      Text(
                        '${profile.vehicleNumber} • ${profile.truckType.getLocalizedLabel(l10n)}',
                        style: AppTypography.bodyMedium.copyWith(
                          color: AppColors.textSecondary,
                        ),
                      ),
                      const SizedBox(height: 2.0),
                      Text(
                        l10n.monthlyCancellations((profile.monthlyCancelCount?.count ?? 0).toString()),
                        style: AppTypography.bodyMedium.copyWith(
                          fontSize: 12.0,
                          color: AppColors.textSecondary,
                        ),
                      ),
                    ],
                  ),
                ),
              ],
            ),
            const SizedBox(height: 12.0),
            Container(
              padding: const EdgeInsets.symmetric(horizontal: 10.0, vertical: 4.0),
              decoration: BoxDecoration(
                color: AppColors.primaryContainer,
                borderRadius: BorderRadius.circular(8.0),
              ),
              child: Row(
                mainAxisSize: MainAxisSize.min,
                children: [
                  const Icon(Icons.check_circle, size: 16.0, color: AppColors.primary),
                  const SizedBox(width: 6.0),
                  Flexible(
                    child: Text(
                      l10n.driverSetupComplete,
                      style: AppTypography.bodyMedium.copyWith(
                        color: AppColors.primaryLight,
                        fontWeight: FontWeight.w600,
                      ),
                      overflow: TextOverflow.ellipsis,
                    ),
                  ),
                ],
              ),
            ),
            if (profile.strictMode) ...[
              const SizedBox(height: 8.0),
              Container(
                key: const ValueKey('strict_mode_badge'),
                padding: const EdgeInsets.symmetric(horizontal: 8.0, vertical: 4.0),
                decoration: BoxDecoration(
                  color: AppColors.error.withValues(alpha: 0.12),
                  borderRadius: BorderRadius.circular(8.0),
                  border: Border.all(color: AppColors.error),
                ),
                child: Row(
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    const Icon(Icons.shield_outlined, size: 14.0, color: AppColors.error),
                    const SizedBox(width: 6.0),
                    Text(
                      l10n.strictModeActive,
                      style: AppTypography.bodyMedium.copyWith(
                        fontSize: 11.0,
                        color: AppColors.error,
                        fontWeight: FontWeight.bold,
                      ),
                    ),
                  ],
                ),
              ),
            ],
          ],
        ),
      ),
    );
  }
}
