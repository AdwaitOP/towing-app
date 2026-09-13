import 'dart:io';
import 'package:camera/camera.dart';
import 'package:flutter/material.dart';
import '../../../core/models/driver_profile.dart';
import '../../../core/models/kyc_error_category.dart';
import '../../../core/services/auth_service.dart';
import '../../../l10n/app_localizations.dart';
import '../../../theme/app_colors.dart';
import '../controllers/kyc_controller.dart';
import 'kyc_review_screen.dart';

class KycCameraScreen extends StatefulWidget {
  final KycDocType docType;
  final KycController controller;
  final DriverProfile profile;
  final AuthService authService;
  final bool isRetake;
  final Future<File?> Function()? onSimulatedCaptureForTest;
  final List<CameraDescription>? camerasForTest;
  final CameraController Function(CameraDescription description)? cameraControllerBuilder;

  const KycCameraScreen({
    super.key,
    required this.docType,
    required this.controller,
    required this.profile,
    required this.authService,
    this.isRetake = false,
    this.onSimulatedCaptureForTest,
    this.camerasForTest,
    this.cameraControllerBuilder,
  });

  @override
  State<KycCameraScreen> createState() => _KycCameraScreenState();
}

class _KycCameraScreenState extends State<KycCameraScreen> with WidgetsBindingObserver {
  CameraController? _cameraController;
  KycErrorCategory? _cameraErrorCategory;
  File? _capturedFile;

  // Explicitly separated lifecycle and operation identities
  bool _disposeRequested = false;
  bool _isAppResumed = true;
  int _cameraGeneration = 0;

  Object? _activeInitToken;
  Future<void>? _activeInitFuture;
  Future<XFile>? _activeCapture;
  Future<void>? _pendingTeardown;

  bool get _isInitializing => _activeInitToken != null;
  KycErrorCategory? get cameraErrorCategory => _cameraErrorCategory;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    _ensureCameraReady();
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    _disposeRequested = true;
    _isAppResumed = false;
    _cameraGeneration++;
    _activeInitToken = null;

    final controllerToDispose = _cameraController;
    _cameraController = null;

    if (controllerToDispose != null) {
      final captureToAwait = _activeCapture;
      if (captureToAwait != null) {
        captureToAwait.then((xFile) {
          try {
            File(xFile.path).deleteSync();
          } catch (_) {}
        }).catchError((_) {}).whenComplete(() async {
          try {
            await controllerToDispose.dispose();
          } catch (_) {}
        });
      } else {
        try {
          controllerToDispose.dispose();
        } catch (_) {}
      }
    }

    if (_capturedFile != null && _capturedFile!.existsSync()) {
      try {
        _capturedFile!.deleteSync();
      } catch (_) {}
      _capturedFile = null;
    }
    super.dispose();
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    if (_disposeRequested || !mounted) return;

    if (state == AppLifecycleState.inactive || state == AppLifecycleState.paused) {
      _isAppResumed = false;
      _cameraGeneration++;
      _activeInitToken = null;

      final controllerToDispose = _cameraController;
      _cameraController = null;

      if (controllerToDispose != null) {
        final captureToAwait = _activeCapture;
        if (captureToAwait != null) {
          _pendingTeardown = captureToAwait.then((xFile) {
            try {
              File(xFile.path).deleteSync();
            } catch (_) {}
          }).catchError((_) {}).whenComplete(() async {
            try {
              await controllerToDispose.dispose();
            } catch (_) {}
          }).whenComplete(() {
            _pendingTeardown = null;
          });
        } else {
          _pendingTeardown = (() async {
            try {
              await controllerToDispose.dispose();
            } catch (_) {}
          })().whenComplete(() {
            _pendingTeardown = null;
          });
        }
      }

      if (mounted) {
        setState(() {});
      }
    } else if (state == AppLifecycleState.resumed) {
      _isAppResumed = true;
      _ensureCameraReady();
    }
  }

  Future<void> _ensureCameraReady() async {
    if (_disposeRequested || !mounted) return;
    if (!_isAppResumed) return;
    if (_capturedFile != null) return;
    if (_cameraController != null && _cameraController!.value.isInitialized) return;

    // 1. If old controller teardown is in flight, wait for it to complete
    if (_pendingTeardown != null) {
      try {
        await _pendingTeardown;
      } catch (_) {}
      if (_disposeRequested || !mounted || !_isAppResumed || _capturedFile != null) {
        return;
      }
      if (_cameraController != null && _cameraController!.value.isInitialized) {
        return;
      }
    }

    // 2. If an initialization is already in flight, await its completion
    if (_activeInitFuture != null) {
      try {
        await _activeInitFuture;
      } catch (_) {}
      if (_disposeRequested || !mounted || !_isAppResumed || _capturedFile != null) {
        return;
      }
      if (_cameraController != null && _cameraController!.value.isInitialized) {
        return;
      }
    }

    // 3. Start fresh initialization under lock
    final initFuture = _startInitialization();
    _activeInitFuture = initFuture;
    try {
      await initFuture;
    } finally {
      if (identical(_activeInitFuture, initFuture)) {
        _activeInitFuture = null;
      }
    }
  }

  Future<void> _startInitialization() async {
    final myToken = Object();
    _activeInitToken = myToken;
    ++_cameraGeneration;

    if (mounted) {
      setState(() {
        _cameraErrorCategory = null;
      });
    }

    if (widget.onSimulatedCaptureForTest != null) {
      if (identical(_activeInitToken, myToken)) {
        _activeInitToken = null;
      }
      if (mounted) {
        setState(() {});
      }
      return;
    }

    CameraController? controllerToDisposeIfStale;

    try {
      final cameras = widget.camerasForTest ?? await availableCameras();
      if (_disposeRequested || !mounted || !_isAppResumed || !identical(_activeInitToken, myToken)) {
        return;
      }

      if (cameras.isEmpty) {
        if (mounted) {
          setState(() {
            _cameraErrorCategory = KycErrorCategory.cameraUnavailable;
          });
        }
        return;
      }

      final desiredLens = widget.docType == KycDocType.selfie
          ? CameraLensDirection.front
          : CameraLensDirection.back;

      final matchingCameras = cameras.where((c) => c.lensDirection == desiredLens).toList();
      if (matchingCameras.isEmpty) {
        // FAIL-CLOSED: No cameras.first fallback, zero controllers created!
        if (mounted) {
          setState(() {
            _cameraErrorCategory = KycErrorCategory.cameraUnavailable;
          });
        }
        return;
      }

      final selectedCamera = matchingCameras.first;

      if (_disposeRequested || !mounted || !_isAppResumed || !identical(_activeInitToken, myToken)) {
        return;
      }

      final controller = widget.cameraControllerBuilder != null
          ? widget.cameraControllerBuilder!(selectedCamera)
          : CameraController(
              selectedCamera,
              ResolutionPreset.high,
              enableAudio: false,
              imageFormatGroup: ImageFormatGroup.jpeg,
            );

      controllerToDisposeIfStale = controller;

      await controller.initialize();

      if (_disposeRequested || !mounted || !_isAppResumed || !identical(_activeInitToken, myToken)) {
        controllerToDisposeIfStale = null;
        try {
          await controller.dispose();
        } catch (_) {}
        return;
      }

      controllerToDisposeIfStale = null;
      _cameraController = controller;

      if (mounted) {
        setState(() {});
      }
    } on CameraException catch (e) {
      if (controllerToDisposeIfStale != null) {
        try {
          await controllerToDisposeIfStale.dispose();
        } catch (_) {}
        controllerToDisposeIfStale = null;
      }
      if (_cameraController != null) {
        final c = _cameraController;
        _cameraController = null;
        try {
          await c?.dispose();
        } catch (_) {}
      }

      if (mounted && !_disposeRequested && _isAppResumed && identical(_activeInitToken, myToken)) {
        KycErrorCategory category;
        switch (e.code) {
          case 'CameraAccessDenied':
            category = KycErrorCategory.cameraPermissionDenied;
            break;
          case 'CameraAccessDeniedWithoutPrompt':
          case 'CameraAccessRestricted':
            category = KycErrorCategory.cameraPermissionPermanentlyDenied;
            break;
          default:
            category = KycErrorCategory.cameraUnavailable;
        }
        setState(() {
          _cameraErrorCategory = category;
        });
      }
    } catch (e) {
      if (controllerToDisposeIfStale != null) {
        try {
          await controllerToDisposeIfStale.dispose();
        } catch (_) {}
        controllerToDisposeIfStale = null;
      }
      if (_cameraController != null) {
        final c = _cameraController;
        _cameraController = null;
        try {
          await c?.dispose();
        } catch (_) {}
      }

      if (mounted && !_disposeRequested && _isAppResumed && identical(_activeInitToken, myToken)) {
        setState(() {
          _cameraErrorCategory = KycErrorCategory.cameraUnavailable;
        });
      }
    } finally {
      if (controllerToDisposeIfStale != null) {
        try {
          await controllerToDisposeIfStale.dispose();
        } catch (_) {}
      }
      if (identical(_activeInitToken, myToken)) {
        _activeInitToken = null;
      }
      if (mounted) {
        setState(() {});
      }
    }
  }

  Future<void> _capturePhoto() async {
    if (widget.onSimulatedCaptureForTest != null) {
      final file = await widget.onSimulatedCaptureForTest!();
      if (file != null && mounted && !_disposeRequested) {
        setState(() {
          _capturedFile = file;
        });
      }
      return;
    }

    if (_disposeRequested ||
        !_isAppResumed ||
        _cameraController == null ||
        !_cameraController!.value.isInitialized ||
        _activeCapture != null) {
      return;
    }

    final currentGen = _cameraGeneration;
    final controller = _cameraController!;
    final myCapture = controller.takePicture();
    _activeCapture = myCapture;

    try {
      final xFile = await myCapture;

      if (_disposeRequested || !mounted || !_isAppResumed || _cameraGeneration != currentGen) {
        try {
          File(xFile.path).deleteSync();
        } catch (_) {}
        return;
      }

      setState(() {
        _capturedFile = File(xFile.path);
      });
    } catch (e) {
      if (_disposeRequested || !mounted || !_isAppResumed || _cameraGeneration != currentGen) {
        return;
      }
      final l10n = AppLocalizations.of(context)!;
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(content: Text(l10n.photoCaptureFailed)),
      );
    } finally {
      if (identical(_activeCapture, myCapture)) {
        _activeCapture = null;
      }

      if (!_disposeRequested && mounted && _isAppResumed && _capturedFile == null && _cameraController == null) {
        _ensureCameraReady();
      }
    }
  }

  void _retakePhoto() {
    if (_capturedFile != null && _capturedFile!.existsSync()) {
      try {
        _capturedFile!.deleteSync();
      } catch (_) {}
    }
    setState(() {
      _capturedFile = null;
    });
    if (_cameraController == null || !_cameraController!.value.isInitialized) {
      _ensureCameraReady();
    }
  }

  void _acceptPhoto() {
    if (_capturedFile == null) return;
    final file = _capturedFile!;
    _capturedFile = null; // Ownership explicitly transferred

    if (widget.isRetake) {
      Navigator.of(context).pop(file);
      return;
    }

    switch (widget.docType) {
      case KycDocType.id:
        widget.controller.setIdFile(file);
        break;
      case KycDocType.rc:
        widget.controller.setRcFile(file);
        break;
      case KycDocType.selfie:
        widget.controller.setSelfieFile(file);
        break;
    }

    if (widget.controller.hasAllDocuments) {
      Navigator.of(context).pushReplacement(
        MaterialPageRoute(
          builder: (_) => KycReviewScreen(
            controller: widget.controller,
            profile: widget.profile,
            authService: widget.authService,
          ),
        ),
      );
      return;
    }

    // Step progression
    if (widget.docType == KycDocType.id) {
      Navigator.of(context).pushReplacement(
        MaterialPageRoute(
          builder: (_) => KycCameraScreen(
            docType: KycDocType.rc,
            controller: widget.controller,
            profile: widget.profile,
            authService: widget.authService,
            onSimulatedCaptureForTest: widget.onSimulatedCaptureForTest,
            camerasForTest: widget.camerasForTest,
            cameraControllerBuilder: widget.cameraControllerBuilder,
          ),
        ),
      );
    } else if (widget.docType == KycDocType.rc) {
      Navigator.of(context).pushReplacement(
        MaterialPageRoute(
          builder: (_) => KycCameraScreen(
            docType: KycDocType.selfie,
            controller: widget.controller,
            profile: widget.profile,
            authService: widget.authService,
            onSimulatedCaptureForTest: widget.onSimulatedCaptureForTest,
            camerasForTest: widget.camerasForTest,
            cameraControllerBuilder: widget.cameraControllerBuilder,
          ),
        ),
      );
    }
  }

  @override
  Widget build(BuildContext context) {
    final l10n = AppLocalizations.of(context)!;

    String title;
    String instruction;
    switch (widget.docType) {
      case KycDocType.id:
        title = l10n.kycDocIdTitle;
        instruction = l10n.cameraCaptureInstructionId;
        break;
      case KycDocType.rc:
        title = l10n.kycDocRcTitle;
        instruction = l10n.cameraCaptureInstructionRc;
        break;
      case KycDocType.selfie:
        title = l10n.kycDocSelfieTitle;
        instruction = l10n.cameraCaptureInstructionSelfie;
        break;
    }

    return Scaffold(
      backgroundColor: Colors.black,
      appBar: AppBar(
        backgroundColor: Colors.black,
        foregroundColor: Colors.white,
        title: Text(title),
      ),
      body: SafeArea(
        child: _capturedFile != null
            ? _buildPreviewLayout(l10n)
            : _buildCameraLayout(l10n, instruction),
      ),
    );
  }

  Widget _buildCameraLayout(AppLocalizations l10n, String instruction) {
    if (_isInitializing || _pendingTeardown != null) {
      return const Center(
        child: CircularProgressIndicator(color: AppColors.primary),
      );
    }

    if (_cameraErrorCategory != null && widget.onSimulatedCaptureForTest == null) {
      final errorMessage = _cameraErrorCategory!.toLocalizedMessage(l10n);

      return Center(
        child: Padding(
          padding: const EdgeInsets.all(24.0),
          child: Column(
            mainAxisAlignment: MainAxisAlignment.center,
            children: [
              const Icon(Icons.camera_alt_outlined, color: AppColors.error, size: 64),
              const SizedBox(height: 16),
              Text(
                errorMessage,
                style: const TextStyle(color: Colors.white, fontSize: 16),
                textAlign: TextAlign.center,
              ),
              const SizedBox(height: 24),
              ElevatedButton(
                onPressed: _ensureCameraReady,
                child: Text(l10n.retry),
              ),
            ],
          ),
        ),
      );
    }

    return Stack(
      children: [
        // Camera Preview
        if (_cameraController != null && _cameraController!.value.isInitialized)
          Center(
            child: CameraPreview(_cameraController!),
          )
        else
          Container(
            color: Colors.black87,
          ),

        // Overlay Guidance
        _buildOverlayGuide(widget.docType),

        // Instruction Text at Top
        Positioned(
          top: 16,
          left: 20,
          right: 20,
          child: Container(
            padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 10),
            decoration: BoxDecoration(
              color: Colors.black54,
              borderRadius: BorderRadius.circular(8),
            ),
            child: Text(
              instruction,
              style: const TextStyle(color: Colors.white, fontSize: 14),
              textAlign: TextAlign.center,
            ),
          ),
        ),

        // Shutter / Capture Button at Bottom
        Positioned(
          bottom: 30,
          left: 0,
          right: 0,
          child: Center(
            child: GestureDetector(
              onTap: _capturePhoto,
              child: Container(
                width: 72,
                height: 72,
                decoration: BoxDecoration(
                  shape: BoxShape.circle,
                  border: Border.all(color: Colors.white, width: 4),
                  color: AppColors.primary,
                ),
                child: const Icon(Icons.camera_alt, color: Colors.white, size: 36),
              ),
            ),
          ),
        ),
      ],
    );
  }

  Widget _buildOverlayGuide(KycDocType docType) {
    if (docType == KycDocType.selfie) {
      // Oval guide for face
      return Center(
        child: Container(
          width: 240,
          height: 320,
          decoration: BoxDecoration(
            borderRadius: BorderRadius.circular(120),
            border: Border.all(color: AppColors.primary, width: 2.5),
          ),
        ),
      );
    } else {
      // Rectangle guide for ID / RC
      return Center(
        child: Container(
          width: 300,
          height: 200,
          decoration: BoxDecoration(
            borderRadius: BorderRadius.circular(12),
            border: Border.all(color: AppColors.primary, width: 2.5),
          ),
        ),
      );
    }
  }

  Widget _buildPreviewLayout(AppLocalizations l10n) {
    return Column(
      children: [
        Expanded(
          child: Center(
            child: _capturedFile != null && _capturedFile!.existsSync()
                ? Image.file(_capturedFile!, fit: BoxFit.contain)
                : const Icon(Icons.broken_image, color: Colors.white54, size: 64),
          ),
        ),
        Container(
          padding: const EdgeInsets.symmetric(horizontal: 24, vertical: 20),
          color: Colors.black87,
          child: Row(
            children: [
              Expanded(
                child: OutlinedButton.icon(
                  onPressed: _retakePhoto,
                  icon: const Icon(Icons.refresh, color: Colors.white),
                  label: Text(l10n.retake, style: const TextStyle(color: Colors.white)),
                  style: OutlinedButton.styleFrom(
                    minimumSize: const Size(0, 48),
                    side: const BorderSide(color: Colors.white54),
                    padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 12),
                  ),
                ),
              ),
              const SizedBox(width: 16),
              Expanded(
                child: ElevatedButton.icon(
                  onPressed: _acceptPhoto,
                  icon: const Icon(Icons.check, color: Colors.white),
                  label: Text(l10n.usePhoto),
                  style: ElevatedButton.styleFrom(
                    minimumSize: const Size(0, 48),
                    backgroundColor: AppColors.primary,
                    foregroundColor: Colors.white,
                    padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 12),
                  ),
                ),
              ),
            ],
          ),
        ),
      ],
    );
  }
}
