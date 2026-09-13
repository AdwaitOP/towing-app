import 'package:flutter/material.dart';
import '../../../core/models/driver_profile.dart';
import '../../../core/services/auth_service.dart';
import '../controllers/kyc_controller.dart';
import '../screens/kyc_consent_screen.dart';
import '../screens/kyc_rejected_screen.dart';

enum KycFlowInitialStep {
  consent,
  rejected,
}

/// Declarative session-scoped KYC flow widget.
/// Manages the lifecycle of [KycController] and hosts a nested [Navigator]
/// so that KYC screen transitions (Consent -> Camera -> Review) remain isolated
/// within this flow and never pollute the root navigator.
class KycFlow extends StatefulWidget {
  final DriverProfile profile;
  final AuthService authService;
  final KycFlowInitialStep initialStep;

  const KycFlow({
    super.key,
    required this.profile,
    required this.authService,
    this.initialStep = KycFlowInitialStep.consent,
  });

  @override
  State<KycFlow> createState() => _KycFlowState();
}

class _KycFlowState extends State<KycFlow> {
  late final KycController _controller;
  final GlobalKey<NavigatorState> _navigatorKey = GlobalKey<NavigatorState>();

  @override
  void initState() {
    super.initState();
    _controller = KycController(authService: widget.authService);
  }

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return PopScope(
      canPop: false,
      onPopInvokedWithResult: (didPop, result) {
        if (didPop) return;
        final navigator = _navigatorKey.currentState;
        if (navigator != null && navigator.canPop()) {
          navigator.pop();
        }
      },
      child: Navigator(
        key: _navigatorKey,
        onGenerateRoute: (settings) {
          final Widget initialWidget;
          if (widget.initialStep == KycFlowInitialStep.rejected ||
              widget.profile.isRejectedVerification) {
            initialWidget = KycRejectedScreen(
              profile: widget.profile,
              authService: widget.authService,
              controller: _controller,
            );
          } else {
            initialWidget = KycConsentScreen(
              profile: widget.profile,
              authService: widget.authService,
              controller: _controller,
            );
          }

          return MaterialPageRoute(
            settings: settings,
            builder: (_) => initialWidget,
          );
        },
      ),
    );
  }
}
