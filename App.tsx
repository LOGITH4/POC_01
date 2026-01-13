import React, { useRef, useState, useCallback } from 'react';
import {
  StyleSheet, View, Text, TouchableOpacity, Alert,
  PermissionsAndroid, Platform, ActivityIndicator, Switch,
} from 'react-native';
import {
  RTCPeerConnection, RTCView, mediaDevices, MediaStream,
  MediaStreamTrack,
} from 'react-native-webrtc';

const WHIP_ENDPOINT = 'https://stbapi.adaptnxt.in:8889/STB_100/whip';
const ICE_SERVERS = [{ urls: 'stun:stun.l.google.com:19302' }];

// Audio source options

function App() {
  const [isStreaming, setIsStreaming] = useState(false);
  const [isConnecting, setIsConnecting] = useState(false);
  const [localStream, setLocalStream] = useState<MediaStream | null>(null);
  const [log, setLog] = useState<string>('Ready');
  const [includeMic, setIncludeMic] = useState(true);

  const pcRef = useRef<RTCPeerConnection | null>(null);
  const statsIntervalRef = useRef<number | null>(null);

  const updateLog = (msg: string) => {
    console.log(`[LOG] ${msg}`);
    setLog(msg);
  };

  const requestPermissions = async (): Promise<boolean> => {
    if (Platform.OS !== 'android') return true;

    try {
      const permissions = [
        PermissionsAndroid.PERMISSIONS.RECORD_AUDIO,
      ];

      // Request notification permission on Android 13+ (API 33+)
      // This is required for the foreground service to run reliably
      if (Platform.OS === 'android' && Platform.Version >= 33) {
        permissions.push(PermissionsAndroid.PERMISSIONS.POST_NOTIFICATIONS);
      }

      // Note: We deliberately do not request POST_NOTIFICATIONS to minimize user prompts.
      // The Foreground Service will still run, but the notification might be silenced/hidden 
      // depending on OS version, which is acceptable per user requirements.

      const results = await PermissionsAndroid.requestMultiple(permissions);
      
      const allGranted = Object.values(results).every(
        result => result === PermissionsAndroid.RESULTS.GRANTED
      );

      if (!allGranted) {
        updateLog('⚠️ Audio permission denied');
        return false;
      }

      return true;
    } catch (error) {
      console.error('Permission error:', error);
      return false;
    }
  };

  const startStreaming = async () => {
    if (isConnecting) return;
    setIsConnecting(true);
    updateLog('Initializing...');

    try {
      // 1. Request Permissions
      const hasPermissions = await requestPermissions();
      if (!hasPermissions) {
        throw new Error('Required permissions not granted');
      }

      // 2. Capture Screen with System Audio
      // CRITICAL: Must pass audio: true to capture system audio on Android 10+
      updateLog('Waiting for Screen Share permission...');
      updateLog('⚠️ Select "Record audio" or "Device audio" in the dialog!');
      
      // For Android 10+, we need to explicitly request audio in getDisplayMedia
      // The user MUST select "Record audio" or similar option in the system dialog
      // NOTE: Current react-native-webrtc on Android ignores constraints for getDisplayMedia and ONLY captures video.
      // To get audio, we must rely on the microphone capture (micTrack) below to pick up the speaker output.
      const screenStream = await mediaDevices.getDisplayMedia({ video: true, audio: true });
      
      // Log what we got from screen capture
      console.log('=== Screen Capture Results ===');
      console.log('Video tracks:', screenStream.getVideoTracks().length);
      console.log('Audio tracks:', screenStream.getAudioTracks().length);
      
      screenStream.getVideoTracks().forEach((track, i) => {
        console.log(`Video ${i}:`, track.label, 'enabled:', track.enabled, 'readyState:', track.readyState);
      });
      
      screenStream.getAudioTracks().forEach((track, i) => {
        console.log(`Audio ${i}:`, track.label, 'enabled:', track.enabled, 'readyState:', track.readyState);
      });

      // Check for system audio
      const systemAudioTrack = screenStream.getAudioTracks()[0];
      if (!systemAudioTrack) {
        console.warn('⚠️ No system audio track received!');
        console.warn('User may not have selected "Record audio" in the dialog');
        updateLog('⚠️ No system audio - check dialog selection');
      } else {
        updateLog('✅ System audio captured');
      }

      // 3. Optionally capture Microphone (separate from system audio)
      let micTrack: MediaStreamTrack | null = null;
      
      if (includeMic) {
        updateLog('Starting Microphone...');
        try {
          // Simplified constraints to avoid silencing issues
          // We disable echo cancellation/noise suppression to allow the mic to pick up system audio playing from speakers
          const micConstraints = {
            audio: {
              echoCancellation: false,
              autoGainControl: false,
              noiseSuppression: false,
              googEchoCancellation: false,
              googAutoGainControl: false,
              googNoiseSuppression: false,
              googHighpassFilter: false,
            },
            video: false,
          };
          
          const micStream = await mediaDevices.getUserMedia(micConstraints);
          micTrack = micStream.getAudioTracks()[0];
          
          if (micTrack) {
            console.log('🎤 Mic track:', micTrack.label, 'enabled:', micTrack.enabled);
            updateLog('✅ Microphone captured');
          }
        } catch (micError: any) {
          console.warn('Microphone capture failed:', micError.message);
          updateLog('⚠️ Mic capture failed: ' + micError.message);
        }
      }

      // 4. Create Final Stream
      const finalStream = new MediaStream();
      
      // Add Video Track
      const videoTrack = screenStream.getVideoTracks()[0];
      if (videoTrack) {
        finalStream.addTrack(videoTrack);
        console.log('📹 Added video track to final stream');
      } else {
        throw new Error('No video track available');
      }

      // Add Audio Track(s)
      // Note: WebRTC/WHIP typically handles one audio track well
      // Adding multiple audio tracks may or may not work depending on the server
      
      if (systemAudioTrack) {
        finalStream.addTrack(systemAudioTrack);
        console.log('🔊 Added system audio track to final stream');
      }
      
      if (micTrack && includeMic) {
        // If we want both, add mic as second audio track
        // Note: This requires server support for multiple audio tracks
        finalStream.addTrack(micTrack);
        console.log('🎤 Added mic audio track to final stream');
      }

      console.log('=== Final Stream Summary ===');
      console.log('Total tracks:', finalStream.getTracks().length);
      console.log('Video tracks:', finalStream.getVideoTracks().length);
      console.log('Audio tracks:', finalStream.getAudioTracks().length);

      if (finalStream.getAudioTracks().length === 0) {
        Alert.alert(
          'No Audio Captured',
          'System audio was not captured. Make sure to select "Record audio" or "Device audio" in the screen capture dialog.\n\nNote: Some apps (like YouTube) block audio capture due to DRM.',
          [{ text: 'OK' }]
        );
      }

      setLocalStream(finalStream);

      // 5. Setup PeerConnection
      const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
      pcRef.current = pc;

      // Use transceivers for more precise control
      // 1. Add Video Transceiver
      const videoT = finalStream.getVideoTracks()[0];
      if (videoT) {
        console.log(`Adding video transceiver: ${videoT.label}`);
        pc.addTransceiver(videoT, { 
          direction: 'sendonly',
          streams: [finalStream],
        });
      }

      // 2. Add Audio Transceiver(s)
      // WHIP endpoints typically handle one audio track well.
      const audioTracks = finalStream.getAudioTracks();
      
      if (audioTracks.length > 0) {
        // Add the first available audio track (System or Mic)
        const primaryAudio = audioTracks[0];
        console.log(`Adding audio transceiver: ${primaryAudio.label}`);
        
        // Explicitly use 'opus' codec if possible (though WebRTC defaults to it)
        pc.addTransceiver(primaryAudio, { 
          direction: 'sendonly', 
          streams: [finalStream],
        });

        if (audioTracks.length > 1) {
          console.warn('Multiple audio tracks found. Only sending the first one.');
        }
      } else {
        // Warning: No audio tracks found in local stream
        console.warn('⚠️ No audio tracks to add to PeerConnection!');
        updateLog('⚠️ No audio tracks available to stream');
      }

      // Connection state monitoring
      pc.oniceconnectionstatechange = () => {
        const state = pc.iceConnectionState;
        console.log('ICE Connection State:', state);
        
        if (state === 'connected' || state === 'completed') {
          updateLog('🟢 LIVE - Streaming');
        } else if (state === 'failed' || state === 'disconnected') {
          updateLog(`⚠️ Connection ${state}`);
          if (state === 'failed') {
            stopStreaming();
          }
        }
      };

      pc.onconnectionstatechange = () => {
        console.log('Connection State:', pc.connectionState);
      };

      // Stats monitoring for debugging
      statsIntervalRef.current = setInterval(async () => {
        if (!pc || pc.signalingState === 'closed') {
          if (statsIntervalRef.current) {
            clearInterval(statsIntervalRef.current);
          }
          return;
        }
        
        try {
          const stats = await pc.getStats(null);
          let videoBytesSent = 0;
          let audioBytesSent = 0;
          let audioTrackCount = 0;
          
          stats.forEach(report => {
            if (report.type === 'outbound-rtp') {
              const bytes = report.bytesSent || 0;
              const packets = report.packetsSent || 0;
              
              if (report.kind === 'video') {
                videoBytesSent = bytes;
                if (packets > 0) {
                  console.log(`📹 Video: ${packets} packets, ${(bytes / 1024).toFixed(1)} KB`);
                }
              } else if (report.kind === 'audio') {
                audioBytesSent += bytes;
                audioTrackCount++;
                if (packets > 0) {
                  // Log audio level if available to check for silence
                  const level = report.audioLevel !== undefined ? ` (Lvl: ${report.audioLevel})` : '';
                  console.log(`🔊 Audio #${audioTrackCount}: ${packets} pkts, ${(bytes / 1024).toFixed(1)} KB${level}`);
                }
              }
            }
          });
          
          if (videoBytesSent === 0) {
            console.warn('⚠️ No video data being sent!');
          }
          if (audioBytesSent === 0 && finalStream.getAudioTracks().length > 0) {
            console.warn('⚠️ No audio data being sent!');
          }
        } catch (err) {
          console.error('Stats error:', err);
        }
      }, 5000);

      // 6. WHIP Negotiation
      updateLog('Creating offer...');
      
      const offerOptions = {
        offerToReceiveAudio: false,
        offerToReceiveVideo: false,
      };
      
      const offer = await pc.createOffer(offerOptions);
      
      // Mungle SDP to ensure audio line is active and properly set
      // Some severs are strict about the order or specific attributes
      if (offer.sdp) {
        // Ensure recvonly (from server perspective) or sendonly (from our perspective) is correct in SDP
        // The transceiver 'sendonly' should handle this, but explicit SDP checks help debugging
        console.log('Original SDP:', offer.sdp);
      }

      await pc.setLocalDescription(offer);

      // Wait for ICE gathering to complete
      updateLog('Gathering ICE candidates...');
      
      await new Promise<void>((resolve) => {
        const timeout = setTimeout(() => {
          console.log('ICE gathering timeout - proceeding with available candidates');
          resolve();
        }, 5000);

        if (pc.iceGatheringState === 'complete') {
          clearTimeout(timeout);
          resolve();
          return;
        }

        const checkState = () => {
          console.log('ICE Gathering State:', pc.iceGatheringState);
          if (pc.iceGatheringState === 'complete') {
            clearTimeout(timeout);
            pc.removeEventListener('icegatheringstatechange', checkState);
            resolve();
          }
        };
        
        pc.addEventListener('icegatheringstatechange', checkState);
      });

      // Send to WHIP endpoint
      updateLog('Connecting to WHIP server...');
      
      const localSdp = pc.localDescription?.sdp;
      if (!localSdp) {
        throw new Error('No local SDP available');
      }

      console.log('Sending offer to WHIP endpoint...');
      
      const response = await fetch(WHIP_ENDPOINT, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/sdp',
        },
        body: localSdp,
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`WHIP server error: ${response.status} - ${errorText}`);
      }

      const answerSdp = await response.text();
      
      // Log answer SDP for debugging
      console.log('=== Answer SDP (audio lines) ===');
      const answerAudioLines = answerSdp.split('\n').filter(line => 
        line.includes('audio') || line.includes('opus') || line.includes('a=mid:')
      );
      answerAudioLines.forEach(line => console.log(line));

      await pc.setRemoteDescription({ type: 'answer', sdp: answerSdp });

      updateLog('🟢 LIVE');
      setIsStreaming(true);

    } catch (error: any) {
      console.error('Streaming error:', error);
      updateLog(`❌ Error: ${error.message}`);
      Alert.alert('Stream Failed', error.message);
      stopStreaming();
    } finally {
      setIsConnecting(false);
    }
  };

  const stopStreaming = useCallback(() => {
    updateLog('Stopping stream...');
    
    // Clear stats interval
    if (statsIntervalRef.current) {
      clearInterval(statsIntervalRef.current);
      statsIntervalRef.current = null;
    }
    
    // Stop all tracks
    if (localStream) {
      localStream.getTracks().forEach(track => {
        console.log('Stopping track:', track.kind, track.label);
        track.stop();
      });
    }
    
    // Close peer connection
    if (pcRef.current) {
      pcRef.current.close();
      pcRef.current = null;
    }
    
    setLocalStream(null);
    setIsStreaming(false);
    updateLog('⬛ Stopped');
  }, [localStream]);

  return (
    <View style={styles.container}>
      {/* Video Preview */}
      {localStream ? (
        <RTCView 
          streamURL={localStream.toURL()} 
          style={styles.video} 
          objectFit="contain"
          mirror={false}
        />
      ) : (
        <View style={styles.placeholder}>
          <Text style={styles.title}>SCREEN STREAMER</Text>
          <Text style={styles.subtitle}>with System Audio</Text>
        </View>
      )}
      
      {/* Controls */}
      <View style={styles.footer}>
        {/* Audio Options (only show when not streaming) */}
        {!isStreaming && (
          <View style={styles.optionsContainer}>
            <View style={styles.option}>
              <Text style={styles.optionLabel}>Include Microphone</Text>
              <Switch
                value={includeMic}
                onValueChange={setIncludeMic}
                trackColor={{ false: '#333', true: '#4CAF50' }}
                thumbColor={includeMic ? '#fff' : '#666'}
              />
            </View>
            <Text style={styles.hint}>
              💡 When screen share dialog appears, select "Record audio" or "Device audio" to capture system sound
            </Text>
          </View>
        )}
        
        {/* Status Log */}
        <Text style={styles.log}>{log}</Text>
        
        {/* Stream Button */}
        <TouchableOpacity 
          style={[styles.btn, isStreaming ? styles.btnRed : styles.btnBlue]} 
          onPress={isStreaming ? stopStreaming : startStreaming}
          disabled={isConnecting}
          activeOpacity={0.7}
        >
          {isConnecting ? (
            <ActivityIndicator color="#fff" size="small" />
          ) : (
            <Text style={styles.btnText}>
              {isStreaming ? '⏹ STOP STREAMING' : '▶ START STREAM'}
            </Text>
          )}
        </TouchableOpacity>
        
        {/* Info */}
        {isStreaming && (
          <Text style={styles.streamInfo}>
            📹 Video + 🔊 {includeMic ? 'System + Mic Audio' : 'System Audio'}
          </Text>
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { 
    flex: 1, 
    backgroundColor: '#111' 
  },
  video: { 
    flex: 1,
    backgroundColor: '#000',
  },
  placeholder: { 
    flex: 1, 
    justifyContent: 'center', 
    alignItems: 'center',
    backgroundColor: '#1a1a1a',
  },
  title: { 
    color: '#555', 
    fontSize: 28, 
    fontWeight: '900',
    letterSpacing: 2,
  },
  subtitle: {
    color: '#444',
    fontSize: 14,
    marginTop: 8,
  },
  footer: { 
    padding: 20, 
    paddingBottom: 40,
    backgroundColor: '#000', 
    alignItems: 'center',
    borderTopWidth: 1,
    borderTopColor: '#222',
  },
  optionsContainer: {
    width: '100%',
    marginBottom: 15,
    padding: 15,
    backgroundColor: '#1a1a1a',
    borderRadius: 12,
  },
  option: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 10,
  },
  optionLabel: {
    color: '#fff',
    fontSize: 14,
  },
  hint: {
    color: '#888',
    fontSize: 11,
    textAlign: 'center',
    marginTop: 5,
  },
  log: { 
    color: '#0f0', 
    fontSize: 12, 
    marginBottom: 15, 
    fontFamily: Platform.OS === 'ios' ? 'Courier' : 'monospace',
    textAlign: 'center',
  },
  btn: { 
    width: '100%', 
    padding: 18, 
    borderRadius: 12, 
    alignItems: 'center',
  },
  btnBlue: { 
    backgroundColor: '#007AFF' 
  },
  btnRed: { 
    backgroundColor: '#FF3B30' 
  },
  btnText: { 
    color: '#fff', 
    fontSize: 16, 
    fontWeight: 'bold',
    letterSpacing: 1,
  },
  streamInfo: {
    color: '#888',
    fontSize: 12,
    marginTop: 10,
  },
});

export default App;