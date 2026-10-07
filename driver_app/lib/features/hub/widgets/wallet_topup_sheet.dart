import 'dart:math' as math;
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../../../core/models/driver_profile.dart';
import '../../../core/services/offer_service.dart';
import '../../../l10n/app_localizations.dart';
import '../../../theme/app_colors.dart';
import '../../../theme/app_typography.dart';

/// Phase 5 Batch 2 Wallet Top-Up Sheet.
///
/// Provides a bottom sheet interface for drivers to add balance to their in-app wallet.
///
/// INVARIANTS:
/// 1. Money values are always validated as safe integer paise (min ₹1 = 100 paise, max ₹100,000 = 10,000,000 paise).
/// 2. RequestId semantics: one unique requestId per logical top-up operation.
///    Retries following timeout or network failure reuse the exact same requestId.
/// 3. Single-flight guard: buttons and inputs are locked while processing.
/// 4. Zero direct client mutation: Flutter never writes directly to driver balance or ledger.
///    It strictly routes through authenticated backend callable `initiateWalletTopup`.
///    Credit authority is derived solely from server-authoritative provider reconciliation.
class WalletTopupSheet extends StatefulWidget {
  final DriverProfile profile;
  final OfferService offerService;
  final void Function(int creditedAmountPaise)? onTopupSuccess;

  const WalletTopupSheet({
    super.key,
    required this.profile,
    required this.offerService,
    this.onTopupSuccess,
  });

  static Future<void> show({
    required BuildContext context,
    required DriverProfile profile,
    required OfferService offerService,
    void Function(int creditedAmountPaise)? onTopupSuccess,
  }) {
    return showModalBottomSheet<void>(
      context: context,
      isScrollControlled: true,
      shape: const RoundedRectangleBorder(
        borderRadius: BorderRadius.vertical(top: Radius.circular(20.0)),
      ),
      builder: (sheetContext) => Padding(
        padding: EdgeInsets.only(
          bottom: MediaQuery.of(sheetContext).viewInsets.bottom,
        ),
        child: WalletTopupSheet(
          profile: profile,
          offerService: offerService,
          onTopupSuccess: onTopupSuccess,
        ),
      ),
    );
  }

  @override
  State<WalletTopupSheet> createState() => _WalletTopupSheetState();
}

class _WalletTopupSheetState extends State<WalletTopupSheet> {
  final TextEditingController _amountController = TextEditingController(text: '500');
  bool _isProcessing = false;
  String? _errorMessage;
  String? _currentRequestId;
  int? _lastAttemptedAmountPaise;

  @override
  void dispose() {
    _amountController.dispose();
    super.dispose();
  }

  void _selectPreset(int rupees) {
    if (_isProcessing) return;
    final newPaise = rupees * 100;
    setState(() {
      if (_lastAttemptedAmountPaise != null && _lastAttemptedAmountPaise != newPaise) {
        _currentRequestId = null;
      }
      _amountController.text = rupees.toString();
      _errorMessage = null;
    });
  }

  int? _parseAmountPaise() {
    final text = _amountController.text.trim();
    final rupees = int.tryParse(text);
    if (rupees == null || rupees < 1 || rupees > 100000) {
      return null;
    }
    return rupees * 100;
  }

  Future<void> _handleTopup() async {
    if (_isProcessing) return;

    final l10n = AppLocalizations.of(context)!;
    final amountPaise = _parseAmountPaise();

    if (amountPaise == null) {
      setState(() {
        _errorMessage = l10n.topupMinMaxError;
      });
      return;
    }

    setState(() {
      _isProcessing = true;
      _errorMessage = null;
      // Logical user operation: if amount changed, generate fresh requestId; otherwise preserve on retry
      if (_lastAttemptedAmountPaise != null && _lastAttemptedAmountPaise != amountPaise) {
        _currentRequestId = null;
      }
      _lastAttemptedAmountPaise = amountPaise;
      _currentRequestId ??= 'req_topup_${DateTime.now().millisecondsSinceEpoch}_${widget.profile.uid.substring(0, math.min(6, widget.profile.uid.length))}';
    });

    try {
      // Step 1: Initiate order on backend (authoritative Razorpay test-mode order)
      final initResult = await widget.offerService.initiateWalletTopup(
        amountPaise: amountPaise,
        requestId: _currentRequestId!,
      );

      if (!mounted) return;

      Navigator.of(context).pop();
      // F01: Pending initiation must NOT invoke onTopupSuccess callback or claim completed credit.
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(
          content: Text(l10n.topupSuccess(initResult.amountRupees.toStringAsFixed(2))),
          backgroundColor: AppColors.surfaceVariant,
        ),
      );
    } catch (e) {
      if (!mounted) return;
      setState(() {
        _isProcessing = false;
        if (e is OfferActionException) {
          _errorMessage = l10n.topupFailed(e.message);
        } else {
          _errorMessage = l10n.topupFailed(e.toString());
        }
      });
    }
  }

  @override
  Widget build(BuildContext context) {
    final l10n = AppLocalizations.of(context)!;

    return SingleChildScrollView(
      padding: const EdgeInsets.all(24.0),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          // Header
          Row(
            mainAxisAlignment: MainAxisAlignment.spaceBetween,
            children: [
              Text(
                l10n.walletTopupTitle,
                style: AppTypography.titleLarge.copyWith(fontWeight: FontWeight.bold),
              ),
              IconButton(
                icon: const Icon(Icons.close),
                onPressed: _isProcessing ? null : () => Navigator.of(context).pop(),
              ),
            ],
          ),
          const Divider(height: 24.0),

          // Current Balance Banner
          Container(
            padding: const EdgeInsets.symmetric(horizontal: 16.0, vertical: 12.0),
            decoration: BoxDecoration(
              color: AppColors.primaryContainer,
              borderRadius: BorderRadius.circular(12.0),
            ),
            child: Row(
              mainAxisAlignment: MainAxisAlignment.spaceBetween,
              children: [
                Text(l10n.walletBalance, style: AppTypography.bodyMedium),
                Text(
                  widget.profile.formattedWalletBalance,
                  style: AppTypography.titleLarge.copyWith(
                    fontWeight: FontWeight.bold,
                    color: AppColors.primary,
                  ),
                ),
              ],
            ),
          ),
          const SizedBox(height: 20.0),

          // Test Mode Notice
          Container(
            padding: const EdgeInsets.all(10.0),
            decoration: BoxDecoration(
              color: AppColors.surfaceVariant,
              borderRadius: BorderRadius.circular(8.0),
              border: Border.all(color: AppColors.border),
            ),
            child: Row(
              children: [
                const Icon(Icons.science_outlined, size: 16.0, color: AppColors.primary),
                const SizedBox(width: 8.0),
                Expanded(
                  child: Text(
                    l10n.testModeNotice,
                    style: AppTypography.bodyMedium.copyWith(fontSize: 11.0, color: AppColors.textSecondary),
                  ),
                ),
              ],
            ),
          ),
          const SizedBox(height: 20.0),

          // Quick Select Chips
          Text(l10n.topupQuickAmount, style: AppTypography.bodyMedium.copyWith(fontWeight: FontWeight.w600)),
          const SizedBox(height: 8.0),
          Row(
            children: [
              _buildPresetChip(500),
              const SizedBox(width: 8.0),
              _buildPresetChip(1000),
              const SizedBox(width: 8.0),
              _buildPresetChip(2000),
            ],
          ),
          const SizedBox(height: 20.0),

          // Custom Amount Input Field
          Text(l10n.enterTopupAmount, style: AppTypography.bodyMedium.copyWith(fontWeight: FontWeight.w600)),
          const SizedBox(height: 8.0),
          TextField(
            key: const ValueKey('topup_amount_field'),
            controller: _amountController,
            enabled: !_isProcessing,
            keyboardType: TextInputType.number,
            inputFormatters: [FilteringTextInputFormatter.digitsOnly],
            onChanged: (val) {
              final newPaise = (int.tryParse(val.trim()) ?? 0) * 100;
              if (_lastAttemptedAmountPaise != null && _lastAttemptedAmountPaise != newPaise) {
                _currentRequestId = null;
              }
            },
            decoration: InputDecoration(
              prefixText: '₹ ',
              hintText: l10n.enterTopupAmount,
              errorText: _errorMessage,
              border: OutlineInputBorder(borderRadius: BorderRadius.circular(10.0)),
            ),
          ),
          const SizedBox(height: 24.0),

          // Submit / Retry Button
          Semantics(
            button: true,
            label: _errorMessage != null ? l10n.retryTopup : l10n.topupSubmit,
            child: FilledButton(
              key: const ValueKey('topup_submit_button'),
              style: FilledButton.styleFrom(
                minimumSize: const Size(double.infinity, 56.0),
                padding: const EdgeInsets.symmetric(vertical: 14.0),
                backgroundColor: AppColors.primary,
              ),
              onPressed: _isProcessing ? null : _handleTopup,
              child: _isProcessing
                  ? const SizedBox(
                      width: 20.0,
                      height: 20.0,
                      child: CircularProgressIndicator(strokeWidth: 2.0, color: Colors.white),
                    )
                  : Text(
                      _errorMessage != null ? l10n.retryTopup : l10n.topupSubmit,
                      style: AppTypography.titleLarge.copyWith(fontSize: 16.0, color: Colors.white),
                    ),
            ),
          ),
        ],
      ),
    );
  }

  Widget _buildPresetChip(int amount) {
    final isSelected = _amountController.text == amount.toString();
    return Expanded(
      child: OutlinedButton(
        key: ValueKey('topup_preset_$amount'),
        style: OutlinedButton.styleFrom(
          backgroundColor: isSelected ? AppColors.primary.withValues(alpha: 0.1) : null,
          side: BorderSide(
            color: isSelected ? AppColors.primary : AppColors.border,
            width: isSelected ? 2.0 : 1.0,
          ),
          shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(8.0)),
        ),
        onPressed: _isProcessing ? null : () => _selectPreset(amount),
        child: Text(
          '₹$amount',
          style: TextStyle(
            color: isSelected ? AppColors.primary : AppColors.onBackground,
            fontWeight: isSelected ? FontWeight.bold : FontWeight.normal,
          ),
        ),
      ),
    );
  }
}
