using System;

namespace TrainerDeckTests
{
    public sealed class SyntheticTrainerWindow
    {
        private readonly SyntheticProtocolReader reader =
            new SyntheticProtocolReader();

        public void TrainerCall_SetFunctionPointers()
        {
        }

        public void TrainerCall_SetCheatOptionState()
        {
            string optionId = reader.ReadString();
            bool enabled = reader.ReadInt32() == 1;
            ConsumeState(optionId, enabled);
        }

        public void TrainerCall_SetOptionList()
        {
            string chinese = "N1 - Synthetic Chinese Option";
            string english = "N1 - Test Option";
            SetupCheatOptions(chinese, english);
        }

        private static void ConsumeState(string optionId, bool enabled)
        {
            if (enabled && string.Equals(optionId, "never", StringComparison.Ordinal))
            {
                throw new InvalidOperationException();
            }
        }

        private void SetupCheatOptions(string chinese, string english)
        {
            if (chinese == null || english == null)
            {
                throw new ArgumentNullException();
            }
        }
    }

    public sealed class SyntheticProtocolReader
    {
        public string ReadString()
        {
            return "N1";
        }

        public int ReadInt32()
        {
            return 1;
        }
    }
}
